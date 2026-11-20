'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
process.env.TZ = 'Asia/Kolkata';
const { buildIntervals, analyzePunchSequence } = require('../src/utils/punches');
// Dependency isolation: report's pure makeDaySummary is evaluated with fake DB models.
const reportPath = path.join(__dirname, '../src/services/report.service.js');
const reportCode = fs.readFileSync(reportPath, 'utf8');
const fakeRequire = (name) => {
  if (name === '../models') return {};
  if (name === './holiday.service') return { listActiveHolidays: async () => [], employeeHolidayEligible: () => false, holidayOccursOn: () => false, calendarKey: () => '' };
  if (name === './shift-assignment.service') return { createReportShiftResolver() {} };
  if (name.startsWith('../')) return require(path.resolve(path.dirname(reportPath), name));
  return require(name);
};
const moduleMock = { exports: {} };
vm.runInNewContext(reportCode, { module: moduleMock, require: fakeRequire, console, process, Date, Math, Number, String, Boolean, Array, Map, Set }, { filename: reportPath });
const { makeDaySummary } = moduleMock.exports;
const D = (s) => new Date(`2026-11-16T${s}:00+05:30`);
const punch = (t, punchType, extra = {}) => ({ timestamp: D(t), punchType, ...extra });
const shift = { startTime: '09:00', endTime: '17:00', lunchStartTime: '13:00', lunchEndTime: '13:30', requiredMinutes: 480 };
const rule = { halfDayEnabled: true, halfDayMinutes: 240, fullDayMinutes: 480, paidLunchEnabled: true,
  overtimeEnabled: true, overtimeRequiresFullRegularShift: true, postShiftOvertimeEnabled: true,
  twoHalfDaysEqualOneDay: true, minimumOvertimeMinutes: 0 };
const summarize = (punches, opts = {}) => makeDaySummary(D('12:00'), punches, { employeeId: 'T001', name: 'Example' },
  shift, null, { ...rule, ...opts }, {}, []);
test('one day: paid lunch, multiple overtime sessions, auto-out identifiable', () => {
 const row = summarize([
  punch('09:00', 'IN'), punch('13:00', 'OUT', { source:'AUTO' }),
  punch('13:30', 'IN', { source:'AUTO_LUNCH_RETURN' }), punch('17:00', 'OUT', { source:'AUTO' }),
  punch('17:15', 'IN'), punch('19:15', 'OUT', { source:'AUTO', isAutoCheckout:true }),
  punch('19:30', 'IN'), punch('20:30', 'OUT')
 ]);
 assert.equal(row.regularWorkedMinutes, 450);
 assert.equal(row.paidLunchMinutes, 30);
 assert.equal(row.regularCreditedMinutes, 480);
 assert.equal(row.postShiftWorkedMinutes, 180);
 assert.equal(row.overtimeMinutes, 180);
 assert.equal(row.autoCheckoutOvertimeMinutes, 120);
 assert.equal(row.verifiedOvertimeMinutes, 60);
 assert.equal(row.overtimeSessionCount, 2);
 assert.equal(row.requiresAttendanceReview, false);
});
test('session spanning shift end: post-shift overlap is counted', () => {
 const row = summarize([punch('16:45', 'IN'), punch('18:00', 'OUT')]);
 assert.equal(row.postShiftWorkedMinutes, 60);
 assert.equal(row.regularWorkedMinutes, 15);
 assert.equal(row.overtimeMinutes, 0, 'full regular shift eligibility not satisfied');
});
test('unknown or consecutive punches are flagged, not credited as verified overtime', () => {
 const r = summarize([punch('09:00','IN'),punch('09:10','IN'),punch('17:00','OUT'),punch('17:10','UNKNOWN')]);
 assert.equal(r.requiresAttendanceReview,true);
 assert.ok(r.sequenceAnomalies.length >= 2);
});
test('unclosed historical IN is not credited as a full day', () => {
 const r = summarize([punch('09:00','IN')]);
 assert.equal(r.workedMinutes,0);
 assert.equal(r.postShiftWorkedMinutes,0);
 assert.equal(r.requiresAttendanceReview,true);
});
test('interval utility retains synthetic OUT flag', () => {
 const i=buildIntervals([punch('17:20','IN'),punch('19:20','OUT',{isAutoCheckout:true,source:'AUTO'})]);
 assert.equal(i[0].minutes,120);
 assert.equal(i[0].autoCheckout,true);
 assert.deepEqual(analyzePunchSequence([punch('17:20','IN'),punch('19:20','OUT')]),[]);
});
test('lunch remains paid when noon auto-checkout is disabled and one session spans lunch', () => {
 const r = summarize([punch('09:00','IN'), punch('17:00','OUT')]);
 assert.equal(r.regularWorkedMinutes,450);
 assert.equal(r.paidLunchMinutes,30);
 assert.equal(r.regularCreditedMinutes,480);
 assert.equal(r.overtimeMinutes,0);
});
test('session straddling 17:00 with completed regular hours earns only post-shift portion', () => {
 const r = summarize([punch('09:00','IN'),punch('13:00','OUT'),punch('13:30','IN'),punch('18:00','OUT')]);
 assert.equal(r.regularCreditedMinutes,480);
 assert.equal(r.postShiftWorkedMinutes,60);
 assert.equal(r.overtimeMinutes,60);
});
test('duplicate OUT punches are flagged for source-day verification', () => {
 const r = summarize([punch('09:00','IN'),punch('17:00','OUT'),punch('17:01','OUT')]);
 assert.equal(r.requiresAttendanceReview,true);
 assert.ok(r.sequenceAnomalies.some(a=>a.type==='UNMATCHED_OUT'));
});
