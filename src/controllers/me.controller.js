const { withAttendanceDisplay, decoratePunches } = require('../utils/attendance-time-display');
const { Employee, Attendance, Leave } = require('../models');
const { getTodayStatus } = require('../services/attendance.service');
const { buildReport } = require('../services/report.service');
const { getEmployeeLeaveBalances, getLeaveHistory } = require('../services/leave.service');

async function profile(req, res) {
  if (!req.user.employeeId) return res.status(404).json({ success: false, message: 'No employee profile is linked to this account' });
  const employee = await Employee.findOne({ employeeId: req.user.employeeId }).populate('shiftId').lean();
  if (!employee) return res.status(404).json({ success: false, message: 'Employee profile not found' });
  res.json({ success: true, employee });
}
async function updateProfile(req, res) {
  if (!req.user.employeeId) return res.status(404).json({ success: false, message: 'No employee profile is linked to this account' });
  const allowed = ['phone', 'email', 'gender', 'profilePhoto'];
  const { validProfilePhoto, validAvatarGender } = require('../utils/profile-photo');
  const body = req.body || {};
  if (Object.hasOwn(body, 'gender') && !validAvatarGender(body.gender)) return res.status(400).json({success:false,message:'Invalid avatar selection'});
  if (Object.hasOwn(body, 'profilePhoto') && !validProfilePhoto(body.profilePhoto)) return res.status(400).json({success:false,message:'Invalid profile photo (PNG/JPEG/WebP, maximum 128 KB)'});
  const update = {};
  for (const key of allowed) if (body[key] != null) update[key] = body[key];
  const employee = await Employee.findOneAndUpdate({ employeeId: req.user.employeeId }, { $set: update }, { new: true, runValidators: true }).lean();
  if (!employee) return res.status(404).json({ success: false, message: 'Employee profile not found' });
  res.json({ success: true, employee });
}
async function attendance(req, res) {
  const from = req.query.from ? new Date(req.query.from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const rows = await Attendance.find({ employeeId: req.user.employeeId, timestamp: { $gte: from, $lte: to } }).sort({ timestamp: 1 }).lean();
  const status = await getTodayStatus(req.user.employeeId);
  res.json({ success: true, count: rows.length, data: await decoratePunches(rows, Employee), todayStatus: status });
}

// Employee-scoped daily attendance summary. Unlike /me/attendance, this endpoint
// includes approved MERGE compensation credits using the same report engine
// used by admin compensation dashboards. Identity comes ONLY from the token.
async function attendanceDaily(req, res) {
  try {
    const employeeId = String(req.user?.employeeId || '').trim();
    if (!employeeId) return res.status(404).json({ success: false, message: 'Employee profile is not linked to this account' });
    const valid = /^\d{4}-\d{2}-\d{2}$/;
    const fromText = String(req.query.from || '');
    const toText = String(req.query.to || '');
    if (!valid.test(fromText) || !valid.test(toText)) {
      return res.status(400).json({ success: false, message: 'from and to must be YYYY-MM-DD' });
    }
    const from = new Date(`${fromText}T12:00:00`);
    const to = new Date(`${toText}T12:00:00`);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) ||
        from.getFullYear() !== Number(fromText.slice(0,4)) ||
        to.getFullYear() !== Number(toText.slice(0,4)) || from > to ||
        (to - from) > 370 * 86400000) {
      return res.status(400).json({ success: false, message: 'Invalid attendance date range (maximum 370 days)' });
    }
    const rows = await buildReport({ from, to, employeeId, employeeIds: [employeeId] });
    const data = rows.filter(row => String(row.employeeId) === employeeId).map(row => withAttendanceDisplay({
      timezone: row.timezone,
      date: row.date,
      employeeId,
      firstIn: row.firstIn,
      lastOut: row.lastOut,
      status: row.status,
      workedMinutes: Number(row.workedMinutes || 0),
      creditedMinutes: Number(row.creditedMinutes || 0),
      separateAdjustmentMinutes: Number(row.separateAdjustmentMinutes || 0),
      effectiveWorkedMinutes: Number(row.effectiveWorkedMinutes ?? row.workedMinutes ?? 0),
      requiredMinutes: Number(row.requiredMinutes || 0),
      missingMinutes: Math.max(0, Number(row.requiredMinutes || 0) - Number(row.effectiveWorkedMinutes ?? row.workedMinutes ?? 0)),
      overtimeMinutes: Number(row.overtimeMinutes || 0),
      lateMinutes: Number(row.lateMinutes || 0),
      earlyOutMinutes: Number(row.earlyDepartureMinutes || 0),
    }));
    return res.json({ success: true, data, count: data.length });
  } catch (error) {
    console.error('[Employee daily attendance] failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to calculate employee daily attendance' });
  }
}

async function leaves(req, res) {
  const year = Number(req.query.year || new Date().getFullYear());
  const [rows, balance] = await Promise.all([
    getLeaveHistory(req.user.employeeId, req.query.year == null ? null : year),
    getEmployeeLeaveBalances(req.user.employeeId, year)
  ]);
  res.json({
    success: true,
    count: rows.length,
    year,
    leaves: rows,
    balance,
    alert: balance.allExhausted
      ? { level: 'warning', code: 'ALL_LEAVE_EXHAUSTED', message: 'All allocated leave balances are exhausted.' }
      : balance.anyExhausted
        ? { level: 'warning', code: 'LEAVE_TYPE_EXHAUSTED', message: 'One or more leave types have no remaining balance.' }
        : null
  });
}

async function leaveSummary(req, res) {
  const year = Number(req.query.year || new Date().getFullYear());
  const balance = await getEmployeeLeaveBalances(req.user.employeeId, year);
  res.json({
    success: true,
    ...balance,
    alert: balance.allExhausted
      ? { level: 'warning', code: 'ALL_LEAVE_EXHAUSTED', message: 'All allocated leave balances are exhausted.' }
      : balance.anyExhausted
        ? { level: 'warning', code: 'LEAVE_TYPE_EXHAUSTED', message: 'One or more leave types have no remaining balance.' }
        : null
  });
}
module.exports = { profile, updateProfile, attendance, attendanceDaily, leaves, leaveSummary };
