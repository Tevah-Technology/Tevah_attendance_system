// Read-only check: does NOT change attendance, approvals or indexes.
// node -r dotenv/config scripts/diagnose-compensation-credit.js EMP007 2026-11-19
const mongoose = require('mongoose');
const { Compensation } = require('../src/models');
const { buildReport } = require('../src/services/report.service');
const employeeId = process.argv[2];
const date = process.argv[3];
if (!/^[\w-]{1,100}$/.test(employeeId || '') ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
  console.error('Usage: node -r dotenv/config scripts/diagnose-compensation-credit.js EMP007 2026-11-19');
  process.exit(2);
}
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const rows = await Compensation.find({ employeeId, date })
      .select('date type status minutes creditMode countTowardsMissingHours creditBucket separateBucket')
      .sort({ createdAt: 1 }).lean();
    const report = await buildReport({ from: date, to: date, employeeId });
    const row = report.find(r => r.employeeId === employeeId);
    console.log(JSON.stringify({
      employeeId, date,
      approvals: rows.map(r => ({
        id: String(r._id), type: r.type, status: r.status, minutes: r.minutes,
        creditMode: r.creditMode ?? 'MERGE (legacy)',
        countTowardsMissingHours: r.countTowardsMissingHours === true,
        creditBucket: r.creditBucket ?? null,
        separateBucket: r.separateBucket ?? null
      })),
      report: row ? {
        requiredMinutes: row.requiredMinutes,
        workedMinutes: row.workedMinutes,
        creditedMinutes: row.creditedMinutes,
        separateAdjustmentMinutes: row.separateAdjustmentMinutes,
        effectiveWorkedMinutes: row.effectiveWorkedMinutes,
        missingMinutes: Math.max(0, (row.requiredMinutes || 0)-(row.effectiveWorkedMinutes || 0))
      } : null
    }, null, 2));
  } finally { await mongoose.disconnect(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
