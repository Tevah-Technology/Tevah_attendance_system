'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateAllowance,annualAllocation}=require('../src/services/employee-leave-allowance.service');
const Allowance=require('../src/models/EmployeeLeaveAllowance');
const Policy=require('../src/models/EmployeeLeavePolicy');
const Profile=require('../src/models/LeavePolicyProfile');
const CalendarProfile=require('../src/models/HolidayCalendarProfile');
const {Holiday}=require('../src/models');
const {validateProfileRules,employeeLeaveRule,effectiveLeavePolicy}=require('../src/services/leave-rule.service');
const {validateCalendar}=require('../src/controllers/holiday-calendar-profile.controller');
const {listActiveHolidays}=require('../src/services/holiday.service');
const {recurringDates}=require('../src/services/recurring-leave.service');
const {validate,resolve,resolveRules,archiveVersion}=require('../src/services/employee-exception.service');
const {makeDaySummary}=require('../src/services/report.service');
const key='2026-11-28';
const row=(opts={})=>({...validate({category:'hours',schedule:'single',startDate:key,mode:'override',minutes:240,reason:'Approved',...opts}),_id:'1',active:true});
const day=new Date(2026,10,28);
const employee={employeeId:'E1',name:'Employee'};
const shift={shiftType:'WORKING_HOURS_ONLY',requiredMinutes:480,enableOvertime:true,workingDays:[1,2,3,4,5,6]};
const punches=[{punchType:'IN',timestamp:new Date(2026,10,28,10)},{punchType:'OUT',timestamp:new Date(2026,10,28,16)}];
test('allowance validation accepts zero and half-day increments; rejects bad inputs',()=>{
 assert.equal(validateAllowance({year:2026,annualAllocation:0,reason:'Approved'}).annualAllocation,0);
 assert.equal(validateAllowance({year:2026,annualAllocation:12.5,reason:'Approved'}).annualAllocation,12.5);
 for(const allocation of [-1,366.5,'12',NaN,1.25])assert.throws(()=>validateAllowance({year:2026,annualAllocation:allocation,reason:'Approved'}));
 assert.throws(()=>validateAllowance({year:2026,annualAllocation:12,reason:''}));
});
test('employee allowance is scoped to employee/type/year and preserves zero; fallback is company default',async()=>{
 const old=Allowance.findOne;let seen;try{
  Allowance.findOne=q=>{seen=q;return{lean:async()=>({annualAllocation:0})}};
  const type={_id:'T1',annualAllocation:15};assert.equal(await annualAllocation('E1',type,2026),0);assert.deepEqual(seen,{employeeId:'E1',leaveTypeId:'T1',year:2026});
  Allowance.findOne=()=>({lean:async()=>null});assert.equal(await annualAllocation('E1',type,2027),15);
 }finally{Allowance.findOne=old;}
});
test('leave profile rules reject unknown or malformed fields and preserve explicit type overrides',()=>{
 const rules=validateProfileRules({approvalRequired:false,maxLeaveDaysPerYear:12,sickLeaveCodes:['sl','SL']});
 assert.deepEqual(rules.sickLeaveCodes,['SL']);assert.equal(effectiveLeavePolicy(rules,{approvalRequired:true}).approvalRequired,true);
 assert.throws(()=>validateProfileRules({approvalRequired:'false'}));assert.throws(()=>validateProfileRules({foo:true}));assert.throws(()=>validateProfileRules({maxLeaveDaysPerYear:-1}));
});
test('yearly leave policy assignment applies profile with fallback for unassigned employees',async()=>{
 const a=Policy.findOne,p=Profile.findById;try{
  Policy.findOne=q=>({lean:async()=>q.year===2026?{profileId:'P1'}:null});
  Profile.findById=()=>({lean:async()=>({_id:'P1',rules:{approvalRequired:false}})});
  assert.equal((await employeeLeaveRule('E1',2026,{approvalRequired:true})).approvalRequired,false);
  assert.equal((await employeeLeaveRule('E1',2027,{approvalRequired:true})).approvalRequired,true);
 }finally{Policy.findOne=a;Profile.findById=p;}
});
test('calendar validation rejects invalid, duplicate or wrong-year holiday labels',()=>{
 assert.deepEqual(validateCalendar({year:2026,holidays:[{date:'2026-12-25',name:'Christmas'}]}),[{date:'2026-12-25',name:'Christmas'}]);
 for(const holidays of [[{date:'2026-02-30',name:'Bad'}],[{date:'2025-12-25',name:'Bad'}],[{date:'2026-12-25',name:'A'},{date:'2026-12-25',name:'B'}]])assert.throws(()=>validateCalendar({year:2026,holidays}));
});
test('employee holiday modes custom, both, none and company fallback resolve by year',async()=>{
 const h=Holiday.find,c=CalendarProfile.find;try{
  Holiday.find=()=>({sort:()=>({lean:async()=>[{_id:'H',date:new Date(2026,11,24),name:'Company holiday',active:true,appliesTo:'ALL'}]})});
  CalendarProfile.find=()=>({lean:async()=>[{_id:'C',holidays:[{date:'2026-12-25',name:'Personal holiday'}]}]});
  for(const [mode,expected] of [['custom',['Personal holiday']],['both',['Company holiday','Personal holiday']],['none',[]],['company',['Company holiday']]]){
   const rows=await listActiveHolidays(new Date(2026,11,24),new Date(2026,11,26),{...employee,holidayCalendarAssignments:[{year:2026,mode,profileId:'C'}]});assert.deepEqual(rows.map(r=>r.name),expected);
  }
 }finally{Holiday.find=h;CalendarProfile.find=c;}
});
test('recurring leave enumerates bounded weekdays; rejects indefinite and cross-year ranges',()=>{
 assert.deepEqual(recurringDates({startDate:'2026-11-27',endDate:'2026-12-05',weekdays:[6]}),['2026-11-28','2026-12-05']);
 for(const x of [{startDate:'2026-11-27',weekdays:[6]},{startDate:'2026-12-31',endDate:'2027-01-02',weekdays:[6]},{startDate:'2026-02-30',endDate:'2026-03-01',weekdays:[6]}])assert.throws(()=>recurringDates(x));
});
test('date-specific rules apply per-field precedence and reject geofence overrides',()=>{
 const recurring=row({category:'rules',mode:'override',schedule:'recurring',startDate:'2026-11-01',weekdays:[6],ruleOverrides:{overtimeEnabled:true,noonAutoCheckoutEnabled:false}});
 const single={...row({category:'rules',mode:'override',ruleOverrides:{overtimeEnabled:false}}),_id:'2'};
 const result=resolveRules([single,recurring],key,{overtimeEnabled:true,autoCheckoutEnabled:true});assert.equal(result.overtimeEnabled,false);assert.equal(result.noonAutoCheckoutEnabled,false);assert.equal(result.autoCheckoutEnabled,true);
 assert.throws(()=>row({category:'rules',mode:'override',ruleOverrides:{geofenceEnabled:false}}));
});
test('exception edit and removal preserve earlier versions, use new values from effective date',()=>{
 const original=row({schedule:'recurring',startDate:'2026-11-01',weekdays:[6]});
 const changed={...original,...archiveVersion(original,'2026-11-29'),minutes:360};
 assert.equal(resolve([changed],key,480).minutes,240);assert.equal(resolve([changed],'2026-12-05',480).minutes,360);
 const removed={...changed,...archiveVersion(changed,'2026-12-06'),active:false};
 assert.equal(resolve([removed],key,480).minutes,240);assert.equal(resolve([removed],'2026-12-05',480).minutes,360);assert.equal(resolve([removed],'2026-12-12',480).minutes,480);
});
test('hourly leave reduces target without crediting punches or creating overtime from leave',()=>{
 const result=makeDaySummary(day,punches,employee,shift,{leaveMinutes:120,days:0.25},{overtimeEnabled:true,fullDayMinutes:480});
 assert.equal(result.requiredMinutes,360);assert.equal(result.workedMinutes,360);assert.equal(result.creditedMinutes,0);assert.equal(result.overtimeMinutes,0);assert.equal(result.status,'PRESENT');assert.equal(result.attendanceDayStatus,'FULL_DAY');assert.equal(result.leave.minutes,120);
 const empty=makeDaySummary(day,[],employee,shift,{leaveMinutes:120,days:0.25},{fullDayMinutes:480});assert.equal(empty.status,'ABSENT');assert.equal(empty.requiredMinutes,360);
});
test('date rule disables hours-only overtime while retaining shift requirement',()=>{
 const p=[{punchType:'IN',timestamp:new Date(2026,10,28,9)},{punchType:'OUT',timestamp:new Date(2026,10,28,19)}];
 const rule=resolveRules([row({category:'rules',mode:'override',ruleOverrides:{overtimeEnabled:false}})],key,{fullDayMinutes:480,overtimeEnabled:true});
 const r=makeDaySummary(day,p,employee,shift,null,rule);assert.equal(r.requiredMinutes,480);assert.equal(r.overtimeMinutes,0);
});
test('custom holiday has zero attendance requirement',()=>{
 const r=makeDaySummary(day,[],employee,shift,null,{fullDayMinutes:480},{},[],{name:'Personal holiday'});assert.equal(r.status,'HOLIDAY');assert.equal(r.requiredMinutes,0);
});
test('Saturday leave charges when Saturday is an assigned working day',async()=>{
 const {EmployeeException}=require('../src/models');const {calculateChargeableDays}=require('../src/services/leave.service');
 const h=Holiday.find,e=EmployeeException.find;try{Holiday.find=()=>({sort:()=>({lean:async()=>[]})});EmployeeException.find=()=>({lean:async()=>[]});
 const result=await calculateChargeableDays(day,day,{includeHolidaysInLeaveDays:false,includeWeekendsInLeaveDays:false},{employee,resolveShift:()=>({shift})});assert.equal(result.days,1);
 }finally{Holiday.find=h;EmployeeException.find=e;}
});
