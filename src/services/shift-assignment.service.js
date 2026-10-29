const { Shift, ShiftAssignment, Rule } = require('../models');
const { startOfDay, endOfDay } = require('../utils/time');

function projectDayNumber(date) {
  return new Date(date).getDay() || 7; // Monday=1 ... Sunday=7
}

async function getDefaultShift(employee) {
  if (employee?.shiftId) {
    const employeeShift = await Shift.findById(employee.shiftId).lean();
    if (employeeShift?.active !== false) return employeeShift;
  }

  const rule = await Rule.findOne().lean();
  if (rule?.defaultShiftId) {
    const defaultShift = await Shift.findById(rule.defaultShiftId).lean();
    if (defaultShift?.active !== false) return defaultShift;
  }

  return null;
}

async function getAssignmentForDate(employeeId, date = new Date()) {
  const dayStart = startOfDay(date);
  const dayEnd = endOfDay(date);
  const weekday = projectDayNumber(date);

  // Highest priority: exact single-date assignment.
  let assignment = await ShiftAssignment.findOne({
    employeeId: String(employeeId),
    active: true,
    assignmentType: 'single_date',
    date: { $gte: dayStart, $lt: dayEnd }
  }).sort({ updatedAt: -1, createdAt: -1 }).lean();

  if (assignment) return assignment;

  // Second priority: a date range covering this day.
  assignment = await ShiftAssignment.findOne({
    employeeId: String(employeeId),
    active: true,
    assignmentType: 'date_range',
    startDate: { $lte: dayEnd },
    endDate: { $gte: dayStart }
  }).sort({ updatedAt: -1, createdAt: -1 }).lean();

  if (assignment) return assignment;

  // Third priority: recurring assignment. startDate/endDate are optional bounds.
  assignment = await ShiftAssignment.findOne({
    employeeId: String(employeeId),
    active: true,
    assignmentType: 'recurring',
    recurringDays: weekday,
    $and: [
      { $or: [{ startDate: null }, { startDate: { $lte: dayEnd } }] },
      { $or: [{ endDate: null }, { endDate: { $gte: dayStart } }] }
    ]
  }).sort({ updatedAt: -1, createdAt: -1 }).lean();

  return assignment || null;
}

async function getEffectiveShift(employee, date = new Date()) {
  const assignment = await getAssignmentForDate(employee?.employeeId, date);

  if (assignment) {
    const shift = await Shift.findById(assignment.shiftId).lean();
    if (shift?.active !== false) {
      return {
        shift,
        assignment,
        source: assignment.assignmentType
      };
    }
  }

  const shift = await getDefaultShift(employee);
  return {
    shift,
    assignment: null,
    source: employee?.shiftId ? 'employee_default' : 'company_default'
  };
}

module.exports = {
  getDefaultShift,
  getAssignmentForDate,
  getEffectiveShift,
  projectDayNumber
};
