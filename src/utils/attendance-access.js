'use strict';

const DATE_PERMISSION = 'attendance.date.select';
const INDEPENDENT_PERMISSIONS = [
  'attendance.correct_punch', 'attendance.deduct_hours', DATE_PERMISSION,
];

function canSelectAttendanceDate(access) {
  return access?.roleCode === 'SUPER_ADMIN' || !!access?.permissions?.includes(DATE_PERMISSION);
}

// Use the same server-local calendar as the existing attendance reports.
function localDay(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const dateOnly = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = dateOnly ? new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]) : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return dateOnly && key !== value ? null : key;
}

function isToday(value, now = new Date()) {
  return localDay(value) !== null && localDay(value) === localDay(now);
}

function denyDate(res) {
  return res.status(403).json({ success: false, message: 'Only today’s attendance is available without Attendance Date Selection permission', code: 'PERMISSION_FORBIDDEN', permission: DATE_PERMISSION });
}

function allowDates(req, res, values, now = new Date()) {
  if (canSelectAttendanceDate(req.access)) return true;
  if (values.every(value => isToday(value, now))) return true;
  denyDate(res);
  return false;
}

function requireAttendanceDate(getDates) {
  return (req, res, next) => {
    if (allowDates(req, res, getDates(req))) next();
  };
}

function todayBounds(now = new Date()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return { $gte: start, $lt: end };
}

module.exports = { DATE_PERMISSION, INDEPENDENT_PERMISSIONS, canSelectAttendanceDate, localDay, isToday, denyDate, allowDates, requireAttendanceDate, todayBounds };
