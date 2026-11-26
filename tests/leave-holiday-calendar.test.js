'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.TZ = 'Asia/Kolkata';
const { Holiday, EmployeeException } = require('../src/models');
const { employeeHolidayEligible, holidayOccursOn, calendarKey } = require('../src/services/holiday.service');
const { calculateChargeableDays } = require('../src/services/leave.service');
const { makeDaySummary } = require('../src/services/report.service');
const local = (day) => new Date(`${day}T12:00:00+05:30`);
const holiday = {
  _id: 'test', name: 'Selected employee holiday', type: 'COMPANY',
  date: local('2026-11-20'), appliesTo: 'EMPLOYEES', employeeIds: ['EMP007'],
  departments: [], active: true, recurringAnnual: false
};
function withHolidayQuery(items, callback) {
  const old = Holiday.find;
  const oldExceptionFind = EmployeeException.find;
  EmployeeException.find = () => ({lean:async()=>[]});
  Holiday.find = () => ({ sort: () => ({ lean: async () => items }) });
  return Promise.resolve().then(callback).finally(() => { Holiday.find = old; EmployeeException.find=oldExceptionFind; });
}
test('employee-assigned holiday applies to selected employee only', () => {
  assert.equal(employeeHolidayEligible(holiday, {employeeId:'EMP007'}), true);
  assert.equal(employeeHolidayEligible(holiday, {employeeId:'EMP008'}), false);
  assert.equal(holidayOccursOn(holiday, local('2026-11-20')), true);
  assert.equal(holidayOccursOn(holiday, local('2026-11-21')), false);
});
test('department holiday targets department without matching a different department', () => {
  const h = {...holiday, appliesTo:'DEPARTMENTS', departments:['Technology']};
  assert.equal(employeeHolidayEligible(h, {employeeId:'EMP007',department:'technology'}), true);
  assert.equal(employeeHolidayEligible(h, {employeeId:'EMP008',department:'Finance'}), false);
});
test('optional holidays do not automatically apply to all employees', () => {
  const h={...holiday,type:'OPTIONAL',appliesTo:'ALL'};
  assert.equal(employeeHolidayEligible(h,{employeeId:'EMP007'}),false);
});
test('selected employee excludes assigned holiday and weekend from requested leave range', () => withHolidayQuery([holiday], async () => {
  const start=local('2026-11-20'),end=local('2026-11-23');
  const policy={includeWeekendsInLeaveDays:false,includeHolidaysInLeaveDays:false};
  const included = await calculateChargeableDays(start,end,policy,{employee:{employeeId:'EMP007'}});
  assert.equal(included.days,1);
  assert.equal(included.excludedWeekends,2);
  assert.equal(included.excludedHolidays,1);
  assert.deepEqual(included.chargeableDates.map(calendarKey),['2026-11-23']);
  const other = await calculateChargeableDays(start,end,policy,{employee:{employeeId:'EMP008'}});
  assert.equal(other.days,2);
}));
test('half-day leave on an assigned holiday is rejected, not silently deducted', () => withHolidayQuery([holiday], async () => {
  await assert.rejects(
    calculateChargeableDays(local('2026-11-20'),local('2026-11-20'),
      {includeWeekendsInLeaveDays:false,includeHolidaysInLeaveDays:false},
      {halfDay:true,employee:{employeeId:'EMP007'}}),
    (e) => e.code === 'HALF_DAY_INVALID_DATE'
  );
}));
test('attendance report marks a no-punch employee holiday separately from absence', () => {
  const day=local('2026-11-20');
  const row=makeDaySummary(day,[],{employeeId:'EMP007',name:'Example'},
    {startTime:'09:00',endTime:'17:00',requiredMinutes:480},null,
    {paidLunchEnabled:false,postShiftOvertimeEnabled:false,fullDayMinutes:480}, {}, [], holiday);
  assert.equal(row.status,'HOLIDAY');
  assert.equal(row.holiday.name,'Selected employee holiday');
  assert.equal(row.workedMinutes,0);
  assert.equal(row.creditedMinutes,0);
});
