const test=require('node:test');
const assert=require('node:assert/strict');
const {validate,resolve,matches}=require('../src/services/employee-exception.service');
const {makeDaySummary}=require('../src/services/report.service');
const {ALL_PERMISSIONS}=require('../src/config/permissions');
const key='2026-11-28'; // Saturday
const make=(fields={})=>({...validate({category:'hours',schedule:'single',startDate:key,mode:'override',minutes:240,reason:'Approved exception',...fields}),_id:'1',active:true});
test('four scheduling types, recurring bounds and no end date',()=>{
 assert.ok(matches(make(),key));
 assert.ok(matches(make({schedule:'multiple',dates:['2026-11-28','2026-12-01']}),'2026-12-01'));
 assert.ok(matches(make({schedule:'range',startDate:'2026-11-26',endDate:'2026-11-30'}),key));
 const recurring=make({schedule:'recurring',startDate:'2026-11-01',weekdays:[6]});
 assert.ok(matches(recurring,key));assert.ok(matches(recurring,'2026-12-05'));assert.ok(!matches(recurring,'2026-11-29'));
 assert.ok(!matches({...recurring,endDate:'2026-11-27'},key));
});
test('invalid dates, minutes, and reversed bounds rejected',()=>{
 assert.throws(()=>make({startDate:'2026-02-30'}));assert.throws(()=>make({minutes:-1}));assert.throws(()=>make({minutes:2.5}));
 assert.throws(()=>make({schedule:'range',startDate:'2026-12-01',endDate:key}));
});
test('specific date beats range and recurring; does not stack',()=>{
 const r=make({schedule:'recurring',startDate:'2026-11-01',weekdays:[6],mode:'add',minutes:120});
 const range=make({schedule:'range',startDate:'2026-11-25',endDate:'2026-11-30',mode:'add',minutes:60});
 assert.equal(resolve([r,range,make()],key,480).minutes,240);
 assert.equal(resolve([r,range],key,480).minutes,540);
 assert.equal(resolve([r],key,480).minutes,600);
});
test('reduce, exempt, and inactive exception',()=>{
 assert.equal(resolve([make({mode:'reduce',minutes:600})],key,480).minutes,0);
 assert.equal(resolve([make({mode:'exempt'})],key,480).working,false);
 assert.equal(resolve([{...make(),active:false}],key,480).minutes,480);
});
test('employee holiday and working-day override',()=>{
 const holiday={name:'Company holiday'};
 const work=make({category:'holiday',mode:'working',minutes:360});
 const r=resolve([work],key,480,holiday);assert.equal(r.holiday,null);assert.equal(r.working,true);assert.equal(r.minutes,360);
 const off=resolve([make({category:'holiday',mode:'holiday'})],key,480);assert.equal(off.minutes,0);assert.equal(off.working,false);assert.ok(off.holiday);
});
const shift={shiftType:'WORKING_HOURS_ONLY',requiredMinutes:480,enableOvertime:true,workingDays:[1,2,3,4,5]};
const date=new Date(2026,10,28);const at=h=>new Date(2026,10,28,h);const punches=[{punchType:'IN',timestamp:at(10)},{punchType:'OUT',timestamp:at(15)}];
const row=(exceptions,p=[],holiday=null)=>{const result=resolve(exceptions,key,480,holiday);return makeDaySummary(date,p,{employeeId:'E1',name:'Employee'},shift,null,{overtimeEnabled:true,fullDayMinutes:480},{},[],result.holiday,[],result);};
test('report reflects adjusted target, overtime and original requirement',()=>{
 const r=row([make()],punches);assert.equal(r.requiredMinutes,240);assert.equal(r.originalRequiredMinutes,480);assert.equal(r.overtimeMinutes,60);assert.equal(r.attendanceDayStatus,'FULL_DAY');assert.equal(r.employeeExceptions.length,1);
});
test('exempt day is off and has zero required hours; holiday has zero hours',()=>{
 const r=row([make({mode:'exempt'})]);assert.equal(r.status,'OFF');assert.equal(r.requiredMinutes,0);assert.equal(r.attendanceUnits,0);
 const h=row([make({category:'holiday',mode:'holiday'})]);assert.equal(h.status,'HOLIDAY');assert.equal(h.requiredMinutes,0);
});
test('working holiday becomes an expected working day',()=>{
 const r=row([make({category:'holiday',mode:'working',minutes:360})],[],{name:'Company holiday'});assert.equal(r.status,'ABSENT');assert.equal(r.requiredMinutes,360);assert.equal(r.holiday,null);
});
test('independent exception permissions registered',()=>{for(const key of ['view','create','edit','delete'])assert.ok(ALL_PERMISSIONS.includes('shifts.exceptions.'+key));});
test('holiday exceptions respected when calculating new leave requests',async()=>{
 const {Holiday,EmployeeException}=require('../src/models');
 const {calculateChargeableDays}=require('../src/services/leave.service');
 const originalHoliday=Holiday.find,originalException=EmployeeException.find;
 try {
  Holiday.find=()=>({sort:()=>({lean:async()=>[]})});
  EmployeeException.find=()=>({lean:async()=>[make({category:'holiday',mode:'working',minutes:360})]});
  const policy={includeHolidaysInLeaveDays:false,includeWeekendsInLeaveDays:false};
  assert.equal((await calculateChargeableDays(date,date,policy,{employee:{employeeId:'E1'}})).days,1);
  EmployeeException.find=()=>({lean:async()=>[make({category:'holiday',mode:'holiday',startDate:'2026-11-30'})]});
  const monday=new Date(2026,10,30);
  assert.equal((await calculateChargeableDays(monday,monday,policy,{employee:{employeeId:'E1'}})).days,0);
 } finally {Holiday.find=originalHoliday;EmployeeException.find=originalException;}
});
test('bulk recipient list validates IDs and removes duplicates',()=>{
 const {bulkEmployeeIds}=require('../src/services/employee-exception.service');
 assert.deepEqual(bulkEmployeeIds([' E1 ','E2','E1']),['E1','E2']);
 for(const bad of [[],null,[''],[{}],Array(101).fill('E1')])assert.throws(()=>bulkEmployeeIds(bad));
});
