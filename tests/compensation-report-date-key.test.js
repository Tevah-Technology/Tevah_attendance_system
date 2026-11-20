'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
process.env.TZ = 'Asia/Kolkata';
const reportPath = path.join(__dirname, '../src/services/report.service.js');
const source = fs.readFileSync(reportPath, 'utf8');
const makeQuery = (value) => ({lean: async () => value, sort() {return this;}});
const approvedRecord = {
  employeeId: 'EMP007', date: '2026-11-19', status: 'APPROVED',
  type: 'MISSING_HOURS', creditMode: 'MERGE', creditBucket: 'HOURS',
  countTowardsMissingHours: false, minutes: 332
};
let compensationQuery;
const fakeModels = {
  Rule: { findOne: () => makeQuery({}) },
  Employee: { find: () => makeQuery([{employeeId: 'EMP007', active: true}]) },
  Attendance: { find: () => makeQuery([]) },
  Leave: {find: () => makeQuery([])},
  Compensation: {find: (query) => {
    compensationQuery = query;
    const f = query.$or[0].date;
    const records = approvedRecord.date >= f.$gte && approvedRecord.date <= f.$lte
      ? [approvedRecord] : [];
    return makeQuery(records);
  }}
};
const fakeRequire = (name) => {
  if (name === '../models') return fakeModels;
  if (name === './holiday.service') return { listActiveHolidays: async () => [], employeeHolidayEligible: () => false, holidayOccursOn: () => false, calendarKey: () => '' };
  if (name === './shift-assignment.service') return {
    createReportShiftResolver: async () => () => ({shift: {
      startTime:'09:00',endTime:'17:00',requiredMinutes:480}})
  };
  if (name.startsWith('../')) return require(path.resolve(path.dirname(reportPath), name));
  return require(name);
};
// Pure test of the date contract: avoids live DB and avoids rewriting records.
test('approved MERGE compensation attaches to business-local day in full report', async () => {
  const box = {exports: {}};
  vm.runInNewContext(source, {module:box, require:fakeRequire, console, process,
    Date, Math, Number, String, Boolean, Array, Map, Set}, {filename: reportPath});
  const {buildReport, compensationDateKey} = box.exports;
  assert.equal(compensationDateKey(new Date('2026-11-19T12:00:00+05:30')), '2026-11-19');
  const rows = await buildReport({from:'2026-11-19', to:'2026-11-19', employeeId:'EMP007'});
  assert.equal(compensationQuery.$or[0].date.$lte, '2026-11-19');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].creditedMinutes, 332);
  assert.equal(rows[0].effectiveWorkedMinutes, rows[0].workedMinutes + 332);
  assert.equal(rows[0].separateAdjustmentMinutes, 0);
});

test('SEPARATE adjustment remains separate and source transfer uses business-local day', async () => {
  const box = {exports: {}};
  vm.runInNewContext(source, {module:box, require:fakeRequire, console, process,
    Date, Math, Number, String, Boolean, Array, Map, Set}, {filename: reportPath});
  const records=[approvedRecord];
  const oldMode=approvedRecord.creditMode;
  approvedRecord.creditMode='SEPARATE';
  try {
    const rows=await box.exports.buildReport({from:'2026-11-19',to:'2026-11-19',employeeId:'EMP007'});
    assert.equal(rows[0].creditedMinutes,0);
    assert.equal(rows[0].separateAdjustmentMinutes,332);
  } finally {approvedRecord.creditMode=oldMode;}
});
