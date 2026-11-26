const test=require('node:test');const assert=require('node:assert/strict');const {validateSchedule,resolveShiftSchedule}=require('../src/services/shift-schedule.service');
const {validate}=require('../src/services/employee-exception.service');
const key='2026-11-28';const row=(extra={})=>validate({category:'hours',schedule:'single',startDate:key,mode:'override',minutes:240,reason:'test',...extra});
const shift={workingDays:[1,2,3,4,5,6],weekdayMinutes:{6:120}};
test('weekday target and fallback',()=>{assert.equal(resolveShiftSchedule(shift,[],key,480,null).minutes,120);assert.equal(resolveShiftSchedule(shift,[],'2026-11-30',480,null).minutes,480);assert.equal(resolveShiftSchedule({...shift,weekdayMinutes:{6:0}},[],key,480,null).working,false);});
test('shift exception and employee precedence',()=>{const s={...shift,scheduleExceptions:[row({mode:'add',minutes:60})]};assert.equal(resolveShiftSchedule(s,[],key,480,null).minutes,180);assert.equal(resolveShiftSchedule(s,[row({schedule:'recurring',startDate:'2026-11-01',weekdays:[6],minutes:300})],key,480,null).minutes,300);});
test('holiday conversion and validation',()=>{const s={...shift,scheduleExceptions:[row({category:'holiday',mode:'working',minutes:360})]};assert.equal(resolveShiftSchedule(s,[],key,480,{name:'Holiday'}).holiday,null);assert.equal(resolveShiftSchedule(s,[],key,480,{name:'Holiday'}).minutes,360);assert.throws(()=>validateSchedule({weekdayMinutes:{8:20}}));assert.throws(()=>validateSchedule({weekdayMinutes:{1:-1}}));});
test('report applies configured weekday target and exemption',()=>{
 const {makeDaySummary}=require('../src/services/report.service');const date=new Date(2026,10,28);const punches=[{punchType:'IN',timestamp:new Date(2026,10,28,10)},{punchType:'OUT',timestamp:new Date(2026,10,28,12)}];
 const base={...shift,shiftType:'WORKING_HOURS_ONLY',requiredMinutes:480,enableOvertime:true};
 const result=resolveShiftSchedule(base,[],key,480,null);
 const r=makeDaySummary(date,punches,{employeeId:'E1',name:'Employee'},base,null,{overtimeEnabled:true,fullDayMinutes:480},{},[],result.holiday,[],result);
 assert.equal(r.requiredMinutes,120);assert.equal(r.attendanceDayStatus,'FULL_DAY');assert.equal(r.overtimeMinutes,0);
 const off=resolveShiftSchedule({...base,weekdayMinutes:{6:0}},[],key,480,null);
 const o=makeDaySummary(date,[],{employeeId:'E1'},base,null,{fullDayMinutes:480},{},[],off.holiday,[],off);assert.equal(o.status,'OFF');assert.equal(o.requiredMinutes,0);
});
test('multiple date, range and recurring shift schedules use local date labels',()=>{
 const rows=[row({schedule:'recurring',startDate:'2026-11-01',weekdays:[6],mode:'add',minutes:60}),row({schedule:'range',startDate:'2026-12-01',endDate:'2026-12-10',minutes:180}),row({schedule:'multiple',dates:['2026-12-05','2026-12-12'],minutes:90})];
 const s={...shift,scheduleExceptions:rows};assert.equal(resolveShiftSchedule(s,[],key,480,null).minutes,180);assert.equal(resolveShiftSchedule(s,[],'2026-12-05',480,null).minutes,90);assert.equal(resolveShiftSchedule(s,[],'2026-12-07',480,null).minutes,180);assert.equal(resolveShiftSchedule(s,[],'2026-12-12',480,null).minutes,90);
});
