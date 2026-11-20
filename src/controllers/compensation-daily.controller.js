const { buildReport } = require('../services/report.service');
const { Compensation } = require('../models');
const { getAllowedEmployeeIds } = require('../services/access-scope.service');
function dateKey(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
async function daily(req, res) {
  try {
    const date = String(req.query.date || dateKey(new Date()));
    const parsed = new Date(`${date}T12:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || dateKey(parsed) !== date || date > dateKey(new Date()))
      return res.status(400).json({ success: false, message: 'Use a valid non-future date YYYY-MM-DD' });
    const ids = await getAllowedEmployeeIds(req);
    const rows = await buildReport({ from: date, to: date, employeeIds: ids });
    const today = date === dateKey(new Date());
    // Query only visible employees to avoid exposing another team's decisions.
    const visibleIds = rows.map(r => r.employeeId);
    const activeCredits = visibleIds.length ? await Compensation.find({
      date, employeeId: { $in: visibleIds },
      status: { $in: ['PENDING', 'APPROVED'] },
      creditBucket: 'HOURS'
    }).select('employeeId status').lean() : [];
    const creditByEmployee = new Map();
    for (const credit of activeCredits) {
      const current = creditByEmployee.get(credit.employeeId);
      if (credit.status === 'APPROVED' || !current) creditByEmployee.set(credit.employeeId, credit.status);
    }
    const employees = rows.map(r => {
      const required = Math.max(0, Number(r.requiredMinutes || 0));
      const actual = Math.max(0, Number(r.workedMinutes || 0));
      const credited = Math.max(0, Number(r.creditedMinutes || 0));
      const effective = Math.max(0, Number(r.effectiveWorkedMinutes ?? actual + credited));
      const open = Boolean(r.intervals?.some(i => i.open));
      const nonWorking = ['LEAVE','OFF'].includes(String(r.status || ''));
      const missing = nonWorking ? 0 : Math.max(0, required - effective);
      const hourCreditStatus = creditByEmployee.get(r.employeeId) || null;
      const eligible = !today && !open && !nonWorking && missing > 0 && !hourCreditStatus;
      const eligibilityNote = hourCreditStatus === 'APPROVED'
        ? 'Approved hours compensation exists; revoke before requesting again'
        : hourCreditStatus === 'PENDING'
          ? 'Hours compensation awaiting approval'
          : today ? 'Today is in progress; shortage is provisional'
          : open ? 'Open session; cannot compensate yet'
          : nonWorking ? 'Non-working day' : '';
      return { employeeId: r.employeeId, employeeName: r.employeeName || r.name || '', department: r.department || '',
        date, status: r.status, requiredMinutes: required, workedMinutes: actual, creditedMinutes: credited,
        effectiveWorkedMinutes: effective, missingMinutes: missing,
        separateAdjustmentMinutes: Math.max(0, Number(r.separateAdjustmentMinutes || 0)),
        rawLateMinutes: Number(r.rawLateMinutes || 0),
        lateCompensationMinutes: Number(r.lateCompensationMinutes || 0),
        lateMinutes: Number(r.lateMinutes || 0),
        openSession: open, hourCreditStatus, eligibleForCompensation: eligible,
        note: eligibilityNote };
    });
    return res.json({ success: true, date, provisional: today, employees });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
}
module.exports = { daily };
