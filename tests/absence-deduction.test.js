const {test}=require('node:test');const assert=require('node:assert/strict');
const {coveredDays,uncovered}=require('../src/services/absence-deduction.service');
const row={attendanceDate:'2026-12-01',status:'ABSENT',scheduledWorkingDay:true,requiredMinutes:480,punches:[]};
const leave={status:'PENDING',policySnapshot:{chargeableDates:['2026-12-01']}};
test('absence without request and rejected leave',()=>{assert.equal(uncovered(row,[]),1);assert.equal(uncovered(row,[{...leave,status:'REJECTED'}]),1)});
test('pending or approved leave is not charged twice',()=>{assert.equal(uncovered(row,[leave]),0);assert.equal(uncovered(row,[{...leave,status:'APPROVED',deductBalance:false}]),0)});
test('holiday, scheduled off, exempt hours and punches are excluded',()=>{for(const patch of [{holiday:{}},{scheduledWorkingDay:false},{requiredMinutes:0},{punches:[{}]},{status:'PRESENT'}])assert.equal(uncovered({...row,...patch},[]),0)});
test('pending half day reserves only half',()=>assert.equal(uncovered(row,[{...leave,halfDay:true}]),.5));
