'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
process.env.TZ = 'Asia/Kolkata';
const controller = require('../src/controllers/compensation.controller');
const { Compensation, Employee, AuditLog } = require('../src/models');
const reportPath = path.join(__dirname, '../src/services/report.service.js');
const fakeRequire = (name) => {
  if (name === '../models') return {};
  if (name === './shift-assignment.service') return { createReportShiftResolver() {} };
  if (name.startsWith('../')) return require(path.resolve(path.dirname(reportPath), name));
  return require(name);
};
const box = { exports: {} };
vm.runInNewContext(fs.readFileSync(reportPath, 'utf8'),
  { module: box, require: fakeRequire, console, process, Date, Math, Number, String, Boolean, Array, Map, Set });
const { makeDaySummary } = box.exports;
const at = (t) => new Date(`2026-11-16T${t}:00+05:30`);
const shift = { startTime:'09:00', endTime:'17:00', lunchStartTime:'13:00', lunchEndTime:'13:30', requiredMinutes:480 };
const rule = { paidLunchEnabled:false, postShiftOvertimeEnabled:false, halfDayEnabled:true,
  halfDayMinutes:240, fullDayMinutes:480 };
const sum = (credit) => makeDaySummary(at('12:00'), [
  {timestamp:at('10:00'),punchType:'IN'}, {timestamp:at('15:00'),punchType:'OUT'}
], {employeeId:'EMP007', name:'Example'}, shift, null, rule, {}, credit);

test('MISSING_HOURS MERGE increases credited/effective without changing physical work', () => {
  const before=sum([]), after=sum([{type:'MISSING_HOURS',creditMode:'MERGE',minutes:60}]);
  assert.equal(after.creditedMinutes,60);
  assert.equal(after.workedMinutes,before.workedMinutes);
  assert.equal(after.effectiveWorkedMinutes,before.effectiveWorkedMinutes+60);
});
test('SEPARATE stays independent of credited and effective work', () => {
  const before=sum([]), after=sum([{type:'MISSING_HOURS',creditMode:'SEPARATE',minutes:60}]);
  assert.equal(after.separateAdjustmentMinutes,60);
  assert.equal(after.creditedMinutes,0);
  assert.equal(after.effectiveWorkedMinutes,before.effectiveWorkedMinutes);
});
test('late MERGE hour credits only when explicit new hour-credit flag is true', () => {
  const previous=sum([{type:'LATE_ARRIVAL',creditMode:'MERGE',minutes:30}]);
  const current=sum([{type:'LATE_ARRIVAL',creditMode:'MERGE',minutes:30,countTowardsMissingHours:true}]);
  assert.equal(previous.creditedMinutes,0);
  assert.equal(current.creditedMinutes,30);
  assert.equal(current.lateMinutes,previous.lateMinutes);
});
test('late SEPARATE changes neither late penalty nor credited hours', () => {
  const before=sum([]), after=sum([{type:'LATE_ARRIVAL',creditMode:'SEPARATE',minutes:30}]);
  assert.equal(after.rawLateMinutes,before.rawLateMinutes);
  assert.equal(after.lateMinutes,before.lateMinutes);
  assert.equal(after.creditedMinutes,0);
  assert.equal(after.separateAdjustmentMinutes,30);
});
function mockCreate(body) {
  const old={findOne:Compensation.findOne,create:Compensation.create,exists:Employee.exists,audit:AuditLog.create};
  let saved;
  Compensation.findOne=()=>({select:()=>({lean:async()=>null})});
  Compensation.create=async data=>{saved=data;return {...data,_id:'507f191e810c19729de860eb',status:'PENDING'};};
  Employee.exists=async()=>true; AuditLog.create=async()=>({});
  const req={user:{_id:'507f191e810c19729de860ea',email:'x@example.invalid'},
    access:{roleCode:'SUPER_ADMIN'},method:'POST',originalUrl:'/api/compensations',ip:'127.0.0.1',body};
  const res={code:200,status(n){this.code=n;return this},json(x){this.result=x;return this}};
  return controller.create(req,res).then(()=>({saved,res})).finally(()=>{
    Compensation.findOne=old.findOne;Compensation.create=old.create;
    Employee.exists=old.exists;AuditLog.create=old.audit;
  });
}
const base={employeeId:'EMP007',date:'2026-11-09',minutes:30,reason:'Testing modes'};
test('admin late MERGE request is explicitly eligible for hours credit',async()=>{
 const {saved,res}=await mockCreate({...base,type:'LATE_ARRIVAL',creditMode:'MERGE'});
 assert.equal(res.code,201);assert.equal(saved.countTowardsMissingHours,true);
 assert.equal(saved.creditBucket,'HOURS');assert.equal(saved.lateBucket,'LATE');
});
test('admin late SEPARATE request does not count as hour credit',async()=>{
 const {saved,res}=await mockCreate({...base,type:'LATE_ARRIVAL',creditMode:'SEPARATE'});
 assert.equal(res.code,201);assert.equal(saved.countTowardsMissingHours,false);
 assert.equal(saved.creditBucket,null);assert.equal(saved.separateBucket,'LATE_ARRIVAL');
});
test('SEPARATE overtime transfer is visible but not counted toward effective hours', () => {
  const before = sum([]);
  const after = sum([{type:'EXTRA_HOURS_TRANSFER',creditMode:'SEPARATE',minutes:45,sourceDate:'2026-11-12'}]);
  assert.equal(after.creditedMinutes,0);
  assert.equal(after.transferredInMinutes,0);
  assert.equal(after.separateAdjustmentMinutes,45);
  assert.equal(after.effectiveWorkedMinutes,before.effectiveWorkedMinutes);
});
test('new separate-mode indexes protect pending and approved adjustments', () => {
 const names = new Set(Compensation.schema.indexes().map(([,opt])=>opt.name));
 assert.ok(names.has('one_pending_separate_adjustment_per_type_day'));
 assert.ok(names.has('one_approved_separate_adjustment_per_type_day'));
});
