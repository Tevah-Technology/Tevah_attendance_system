const { Holiday } = require('../models');

function startOfDay(value) {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}
function calendarKey(value) {
  const d = startOfDay(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateKey(value) { return calendarKey(value).slice(5); }
function employeeHolidayEligible(holiday, employee) {
  if (!holiday || holiday.active === false) return false;
  // OPTIONAL holidays must be explicitly assigned; they are not a blanket day off.
  const target = holiday.appliesTo || (holiday.type === 'OPTIONAL' ? 'EMPLOYEES' : 'ALL');
  if (holiday.type === 'OPTIONAL' && target === 'ALL') return false;
  if (target === 'ALL') return true;
  if (!employee) return false;
  if (target === 'EMPLOYEES') {
    return (holiday.employeeIds || []).includes(String(employee.employeeId));
  }
  if (target === 'DEPARTMENTS') {
    return (holiday.departments || []).some(d => String(d).trim().toLowerCase() === String(employee.department || '').trim().toLowerCase());
  }
  return false;
}
function holidayOccursOn(holiday, day) {
  return holiday.recurringAnnual
    ? dateKey(holiday.date) === dateKey(day)
    : calendarKey(holiday.date) === calendarKey(day);
}
async function listActiveHolidays(fromDate, toDate, employee = null) {
  const from = startOfDay(fromDate);
  const to = startOfDay(toDate);
  to.setHours(23, 59, 59, 999);
  const rows = await Holiday.find({
    active: true,
    $or: [{ date: { $gte: from, $lte: to } }, { recurringAnnual: true }]
  }).sort({ date: 1 }).lean();
  return rows.filter(h => {
    if (employee && !employeeHolidayEligible(h, employee)) return false;
    if (!h.recurringAnnual) return true;
    const cursor = new Date(from);
    while (cursor <= to) {
      if (holidayOccursOn(h, cursor)) return true;
      cursor.setDate(cursor.getDate() + 1);
    }
    return false;
  });
}
async function holidayDateKeys(fromDate, toDate, employee = null) {
  const holidays = await listActiveHolidays(fromDate, toDate, employee);
  const exact = new Set();
  const recurring = new Set();
  for (const h of holidays) {
    if (h.recurringAnnual) recurring.add(dateKey(h.date));
    else exact.add(calendarKey(h.date));
  }
  return { exact, recurring, holidays };
}
async function isHolidayDate(value, employee = null) {
  const d = startOfDay(value);
  const { exact, recurring } = await holidayDateKeys(d, d, employee);
  return exact.has(calendarKey(d)) || recurring.has(dateKey(d));
}
module.exports = {
  startOfDay, dateKey, calendarKey, employeeHolidayEligible,
  holidayOccursOn, listActiveHolidays, holidayDateKeys, isHolidayDate
};
