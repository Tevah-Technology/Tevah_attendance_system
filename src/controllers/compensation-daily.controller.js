const { buildReport } = require('../services/report.service');
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
    const employees = rows.map(r => {
      const required = Math.max(0, Number(r.requiredMinutes || 0));
      const actual = Math.max(0, Number(r.workedMinutes || 0));
      const credited = Math.max(0, Number(r.creditedMinutes || 0));
      const effective = Math.max(0, Number(r.effectiveWorkedMinutes ?? actual + credited));
      const open = Boolean(r.intervals?.some(i => i.open));
      const nonWorking = ['LEAVE','OFF'].includes(String(r.status || ''));
      const missing = nonWorking ? 0 : Math.max(0, required - effective);
      return { employeeId: r.employeeId, employeeName: r.employeeName || r.name || '', department: r.department || '',
        date, status: r.status, requiredMinutes: required, workedMinutes: actual, creditedMinutes: credited,
        effectiveWorkedMinutes: effective, missingMinutes: missing, lateMinutes: Number(r.rawLateMinutes || 0),
        openSession: open, eligibleForCompensation: !today && !open && !nonWorking && missing > 0,
        note: today ? 'Today is in progress; shortage is provisional' : open ? 'Open session; cannot compensate yet' : nonWorking ? 'Non-working day' : '' };
    });
    return res.json({ success: true, date, provisional: today, employees });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
}
module.exports = { daily };
