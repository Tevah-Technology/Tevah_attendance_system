const {
  Employee,
  Attendance,
  Shift,
  Rule,
  Leave,
  Compensation
} = require('../models');

const {
  buildIntervals, analyzePunchSequence
} = require('../utils/punches');

const {
  getAttendancePolicy,
  classifyDay,
  aggregateAttendanceUnits
} = require('../utils/attendance-policy');

const { createReportShiftResolver } = require('./shift-assignment.service');
const { listActiveHolidays, employeeHolidayEligible, holidayOccursOn, calendarKey } = require('./holiday.service');

const {
  startOfDay,
  endOfDay,
  minutesBetween,
  atTime,
  dateKey,
  iterateDays
} = require('../utils/time');


// ============================================================
// EMPLOYEE SHIFT
// ============================================================

async function getEmployeeShift(employee) {
  if (employee.shiftId) {
    const shift = await Shift
      .findById(employee.shiftId)
      .lean();

    if (shift) {
      return shift;
    }
  }

  const rule = await Rule
    .findOne()
    .lean();

  if (rule?.defaultShiftId) {
    return Shift
      .findById(rule.defaultShiftId)
      .lean();
  }

  return null;
}


// ============================================================
// BUILD ONE DAY SUMMARY
// ============================================================

function makeDaySummary(
  date,
  punches,
  employee,
  shift,
  leave,
  attendanceRule = {},
  shiftContext = {},
  approvedCompensations = [],
  holiday = null
) {
  const sorted = [...punches]
    .filter((punch) => punch && punch.timestamp)
    .sort(
      (a, b) =>
        new Date(a.timestamp) -
        new Date(b.timestamp)
    );

  const intervals = buildIntervals(sorted);
  const sequenceAnomalies = analyzePunchSequence(sorted);

  const workedMinutes = intervals.reduce(
    (sum, item) =>
      sum + Number(item.minutes || 0),
    0
  );

  // Actual biometric work remains distinct from administratively credited time.
  const creditedMinutes = approvedCompensations.filter(c => c.creditMode !== 'SEPARATE' &&
    (c.type !== 'LATE_ARRIVAL' || c.countTowardsMissingHours === true))
    .reduce((sum, c) => sum + Number(c.minutes || 0), 0);
  const missingHoursCompensationMinutes = approvedCompensations.filter(c => c.type === 'MISSING_HOURS' && c.creditMode !== 'SEPARATE')
    .reduce((sum, c) => sum + Number(c.minutes || 0), 0);
  const transferredInMinutes = approvedCompensations.filter(c =>
    c.type === 'EXTRA_HOURS_TRANSFER' && c.creditMode !== 'SEPARATE')
    .reduce((sum, c) => sum + Number(c.minutes || 0), 0);
  const approvedLateMinutes = approvedCompensations.filter(c =>
    c.type === 'LATE_ARRIVAL' && c.creditMode !== 'SEPARATE')
    .reduce((sum, c) => sum + Number(c.minutes || 0), 0);
  const separateAdjustmentMinutes = approvedCompensations.filter(c => c.creditMode === 'SEPARATE')
    .reduce((sum, c) => sum + Number(c.minutes || 0), 0);
  // Distinguish physical work, paid break credit and post-shift sessions.
  // A paid lunch isn't a biometric work interval or overtime.
  const shiftStartBoundary = atTime(date, shift?.startTime || attendanceRule.morningStartTime || '09:00');
  const shiftEndBoundary = atTime(date, shift?.endTime || attendanceRule.dayEndAutoCheckoutTime || '17:30');
  if (shiftEndBoundary <= shiftStartBoundary) shiftEndBoundary.setDate(shiftEndBoundary.getDate() + 1);
  const lunchStartBoundary = atTime(date, shift?.lunchStartTime || attendanceRule.middayAutoCheckoutTime || '13:00');
  const lunchEndBoundary = atTime(date, shift?.lunchEndTime || attendanceRule.afternoonStartTime || '13:30');
  const validLunch = lunchStartBoundary > shiftStartBoundary && lunchEndBoundary > lunchStartBoundary && lunchEndBoundary < shiftEndBoundary;
  const overlapMinutes = (a, b, c, d) => Math.max(0, Math.round((Math.min(b,d)-Math.max(a,c))/60000));
  const nowForReport = new Date();
  const physicalRegularMinutes = intervals.reduce((sum, it) => it.open ? sum : sum +
    overlapMinutes(new Date(it.in), new Date(it.out), shiftStartBoundary, shiftEndBoundary), 0);
  const postShiftWorkedMinutes = intervals.reduce((sum, it) =>
    it.open ? sum : sum + Math.max(0, Math.round(
      (new Date(it.out) - new Date(Math.max(new Date(it.in).getTime(), shiftEndBoundary.getTime()))) / 60000
    )), 0);
  // Historical unresolved sessions are not presumed to be attended hours.
  // Overtime that was automatically ended must be explicitly inspected by approver.
  const autoCheckoutOvertimeMinutes = intervals.reduce((sum, it) =>
    it.open || !it.autoCheckout ? sum : sum + Math.max(0, Math.round(
      (new Date(it.out) - new Date(Math.max(new Date(it.in).getTime(), shiftEndBoundary.getTime()))) / 60000
    )), 0);
  const crossesLunch = validLunch && intervals.some(it => new Date(it.in) < lunchStartBoundary &&
    new Date(it.out || nowForReport) >= lunchEndBoundary);
  const bothSidesLunch = validLunch &&
    intervals.some(it => new Date(it.in) < lunchStartBoundary && new Date(it.out || nowForReport) >= lunchStartBoundary) &&
    intervals.some(it => new Date(it.in) < shiftEndBoundary && new Date(it.out || nowForReport) > lunchEndBoundary);
  const paidLunchMinutes = attendanceRule.paidLunchEnabled && validLunch &&
    intervals.some(it => !it.open && new Date(it.in) < lunchStartBoundary && new Date(it.out) >= lunchStartBoundary) &&
    intervals.some(it => !it.open && new Date(it.in) < shiftEndBoundary && new Date(it.out) > lunchEndBoundary) &&
    (crossesLunch || bothSidesLunch)
    ? Math.round((lunchEndBoundary-lunchStartBoundary)/60000) : 0;
  // If auto checkout is disabled, an uninterrupted IN interval covers lunch;
  // remove the non-working lunch from physical time before crediting paid lunch.
  const lunchOverlapWorkedMinutes = attendanceRule.paidLunchEnabled && validLunch ?
    intervals.reduce((sum,it) => it.open ? sum : sum + overlapMinutes(new Date(it.in), new Date(it.out),
      lunchStartBoundary, lunchEndBoundary), 0) : 0;
  const regularWorkedMinutes = Math.max(0, physicalRegularMinutes - lunchOverlapWorkedMinutes);
  const regularCreditedMinutes = regularWorkedMinutes + paidLunchMinutes;
  const effectiveWorkedMinutes = attendanceRule.postShiftOvertimeEnabled || attendanceRule.paidLunchEnabled
    ? regularCreditedMinutes + postShiftWorkedMinutes + creditedMinutes
    : workedMinutes + creditedMinutes;
  const policy = getAttendancePolicy(attendanceRule);
  const completedIntervals = intervals.filter(item => !item.open);
  const halfDayIntervals = completedIntervals.filter(item => {
    const c = classifyDay({ workedMinutes: Number(item.minutes || 0), completedIntervals: 1, hasOpenInterval: false }, policy);
    return c.halfDay;
  }).length;

  let attendanceClassification = classifyDay({
    workedMinutes: effectiveWorkedMinutes,
    completedIntervals: completedIntervals.length,
    hasOpenInterval: intervals.some(item => item.open)
  }, policy);

  const hasOpenInterval = intervals.some(item => item.open);
  const isDateSpecificShift = ['single_date', 'date_range', 'recurring'].includes(String(shiftContext?.source || ''));

  // Date-specific shifts are evaluated against that shift's own required minutes
  // and credit value. This lets an approved 16:15-20:15 half shift count as
  // 0.5 day without changing the company-wide 09:00-17:30 rules.
  if (shift && !hasOpenInterval) {
    const required = Math.max(1, Number(shift.requiredMinutes || policy.fullDayMinutes || 480));
    const maxUnits = Math.max(0, Math.min(1, Number(shift.attendanceUnits ?? 1)));

    if (effectiveWorkedMinutes >= required) {
      attendanceClassification = maxUnits >= 1
        ? { status: 'FULL_DAY', label: 'Full Day', attendanceUnits: 1, halfDay: false, fullDay: true, halfDayEligible: true }
        : maxUnits >= 0.5
          ? { status: 'HALF_DAY', label: 'Half Day', attendanceUnits: 0.5, halfDay: true, fullDay: false, halfDayEligible: true }
          : { status: 'INCOMPLETE', label: 'Incomplete', attendanceUnits: 0, halfDay: false, fullDay: false, halfDayEligible: false };
    } else if (maxUnits >= 1 && effectiveWorkedMinutes >= Math.min(policy.halfDayMinutes, required)) {
      attendanceClassification = { status: 'HALF_DAY', label: 'Half Day', attendanceUnits: 0.5, halfDay: true, fullDay: false, halfDayEligible: true };
    }
  }

  // For standard shifts, explicit approved credits can complete an otherwise
  // incomplete day; preserve old split-session logic when no credits exist.
  if (creditedMinutes > 0 && !hasOpenInterval && !shift) {
    attendanceClassification = classifyDay({
      workedMinutes: effectiveWorkedMinutes,
      completedIntervals: Math.max(1, completedIntervals.length),
      hasOpenInterval: false
    }, policy);
  }

  if (policy.halfDayEnabled && policy.twoHalfDaysEqualOneDay && halfDayIntervals >= 2) {
    attendanceClassification = {
      ...attendanceClassification,
      status: 'FULL_DAY',
      label: 'Full Day',
      attendanceUnits: 1,
      halfDay: false,
      fullDay: true
    };
  }

  // In split-day mode, attendance credit is based on participating in the
  // configured morning/afternoon sessions rather than requiring exactly 480
  // worked minutes. This preserves the 09:30 grace window: an employee who
  // checks in at 09:20 and completes both sessions is still a full day.
  if (attendanceRule.halfDayEnabled !== false && !shift && creditedMinutes === 0) {
    const morningStart = atTime(date, attendanceRule.morningStartTime || '09:00');
    const midday = atTime(date, attendanceRule.middayAutoCheckoutTime || '13:00');
    const afternoonStart = atTime(date, attendanceRule.afternoonStartTime || '13:30');
    const dayEnd = atTime(date, attendanceRule.dayEndAutoCheckoutTime || '17:30');
    const now = new Date();

    const overlaps = (item, start, end) => {
      const intervalStart = new Date(item.in);
      const intervalEnd = item.out ? new Date(item.out) : now;
      return intervalStart < end && intervalEnd > start;
    };

    const morningSessionPresent = intervals.some(item => overlaps(item, morningStart, midday));
    const afternoonSessionPresent = intervals.some(item => overlaps(item, afternoonStart, dayEnd));
    const splitSessions = Number(morningSessionPresent) + Number(afternoonSessionPresent);
    const hasOpen = intervals.some(item => item.open);

    if (!hasOpen && policy.twoHalfDaysEqualOneDay && splitSessions >= 2) {
      attendanceClassification = { status: 'FULL_DAY', label: 'Full Day', attendanceUnits: 1, halfDay: false, fullDay: true, halfDayEligible: true };
    } else if (!hasOpen && splitSessions === 1) {
      attendanceClassification = { status: 'HALF_DAY', label: 'Half Day', attendanceUnits: 0.5, halfDay: true, fullDay: false, halfDayEligible: true };
    }
  }

  const firstInPunch = sorted.find((punch) => punch.punchType === 'IN') || null;
  const lastOutPunch = [...sorted].reverse().find((punch) => punch.punchType === 'OUT') || null;

  const firstPunch = firstInPunch?.timestamp || (sorted.length > 0 ? sorted[0].timestamp : null);
  const lastPunch = lastOutPunch?.timestamp || (sorted.length > 0 ? sorted[sorted.length - 1].timestamp : null);

  const shiftStart = shift
    ? atTime(date, shift.startTime)
    : null;

  const shiftEnd = shift
    ? atTime(date, shift.endTime)
    : null;

  // ----------------------------------------------------------
  // LATE
  // ----------------------------------------------------------

  let lateCutoff = atTime(date, attendanceRule.lateAfterTime || '09:30');
  if (shift?.startTime) {
    lateCutoff = atTime(date, shift.startTime);
    lateCutoff.setMinutes(lateCutoff.getMinutes() + Math.max(0, Number(shift.graceMinutes || 0)));
  }
  const rawLateMinutes = firstInPunch
    ? Math.max(0, minutesBetween(lateCutoff, firstInPunch.timestamp))
    : 0;

  const lateCompensationMinutes = firstInPunch
    ? Math.max(0, Number(firstInPunch.lateCompensationMinutes || 0) + approvedLateMinutes)
    : 0;

  const lateMinutes = Math.max(
    0,
    rawLateMinutes - lateCompensationMinutes
  );
  const lateByRule = lateMinutes > 0;

  // ----------------------------------------------------------
  // EARLY DEPARTURE
  // ----------------------------------------------------------

  const earlyDepartureMinutes =
    lastPunch && shiftEnd
      ? Math.max(
          0,
          minutesBetween(
            lastPunch,
            shiftEnd
          )
        )
      : 0;

  // ----------------------------------------------------------
  // BREAK
  // ----------------------------------------------------------

  const breakMinutes =
    firstPunch && lastPunch
      ? Math.max(
          0,
          minutesBetween(
            firstPunch,
            lastPunch
          ) -
            workedMinutes
        )
      : 0;

  // ----------------------------------------------------------
  // OVERTIME
  // ----------------------------------------------------------

  const requiredRegularMinutes = Number(shift?.requiredMinutes ?? attendanceRule.fullDayMinutes ?? 480);
  const fullRegularShift = regularCreditedMinutes >= requiredRegularMinutes;
  const overtimeMinimum = Math.max(0, Number(shift?.minimumOvertimeMinutes ?? attendanceRule.minimumOvertimeMinutes ?? 0));
  const overtimeMinutes = attendanceRule.postShiftOvertimeEnabled
    ? (attendanceRule.overtimeEnabled !== false &&
      (!attendanceRule.overtimeRequiresFullRegularShift || fullRegularShift) &&
      postShiftWorkedMinutes >= overtimeMinimum ? postShiftWorkedMinutes : 0)
    : Math.max(0, workedMinutes - Number(shift?.overtimeAfterMinutes ?? shift?.requiredMinutes ?? 480));

  // ----------------------------------------------------------
  // WORKING DAY
  //
  // JS:
  // Sunday = 0
  // Monday = 1
  // ...
  // Saturday = 6
  //
  // Project shifts use:
  // Monday = 1 ... Sunday = 7
  // ----------------------------------------------------------

  const dayOfWeek =
    new Date(date).getDay() || 7;

  const workingDays =
    Array.isArray(shift?.workingDays)
      ? shift.workingDays
      : [1, 2, 3, 4, 5, 6];

  const workingDay =
    !shift ||
    workingDays.includes(dayOfWeek);

  // ----------------------------------------------------------
  // STATUS
  // ----------------------------------------------------------

  let status;

  if (leave) {
    status = 'LEAVE';
  } else if (sorted.length > 0 || creditedMinutes > 0) {
    status = 'PRESENT';
  } else if (holiday) {
    status = 'HOLIDAY';
  } else if (workingDay) {
    status = 'ABSENT';
  } else {
    status = 'OFF';
  }

  // Clock state is separate from attendance status. "PRESENT" means the
  // employee attended the day, not that their session is currently open.
  // Use the actual, timestamp-ordered IN/OUT records; do not infer a checkout
  // from firstIn/lastOut, which may both point to the same device punch.
  const typedPunches = sorted.filter(p =>
    p.punchType === 'IN' || p.punchType === 'OUT'
  );
  const latestTypedPunch = typedPunches.length
    ? typedPunches[typedPunches.length - 1]
    : null;
  const isToday = dateKey(date) === dateKey(new Date());
  let clockState = 'UNKNOWN';
  if (leave) {
    clockState = 'ON_LEAVE';
  } else if (!latestTypedPunch) {
    if (status === 'ABSENT') clockState = 'NOT_CLOCKED_IN';
  } else if (latestTypedPunch.punchType === 'OUT') {
    clockState = 'CLOCKED_OUT';
  } else if (isToday && hasOpenInterval) {
    clockState = 'CLOCKED_IN';
  }
  // An unmatched IN on a previous day is not proof that the employee
  // remains clocked in today: it may indicate a missing or unsynced OUT.
  const checkedIn = clockState === 'CLOCKED_IN'
    ? true
    : (clockState === 'CLOCKED_OUT' || clockState === 'NOT_CLOCKED_IN'
        ? false : null);

  return {
    date: startOfDay(date),

    employeeId:
      employee.employeeId,

    employeeName:
      employee.name,

    department:
      employee.department || '',

    designation:
      employee.designation || '',

    status,
    holiday: holiday ? { id: holiday._id, name: holiday.name, type: holiday.type } : null,
    leave: leave ? { id: leave._id, type: leave.type, halfDay: Boolean(leave.halfDay) } : null,

    // Authoritative self-attendance state for Daily Attendance Console.
    clockState,
    checkedIn,
    hasOpenSession: isToday ? hasOpenInterval : false,
    lastPunchType: latestTypedPunch?.punchType || null,
    latestPunchType: latestTypedPunch?.punchType || null,
    punchesSorted: true,

    // Detailed day classification used by the frontend/reports.
    attendanceDayStatus: attendanceClassification.status,
    attendanceDayLabel: attendanceClassification.label,
    attendanceUnits: attendanceClassification.attendanceUnits,
    halfDay: attendanceClassification.halfDay,
    fullDay: attendanceClassification.fullDay,
    halfDayEligible: attendanceClassification.halfDayEligible,
    halfDaySessions: halfDayIntervals,

    firstPunch,

    lastPunch,

    // Explicit aliases used by the employee-day API and web UI.
    firstIn: firstInPunch?.timestamp || null,
    lastOut: lastOutPunch?.timestamp || null,

    punches: sorted,

    intervals,

    workedMinutes, // physical work, includes after-shift sessions
    regularWorkedMinutes,
    paidLunchMinutes,
    regularCreditedMinutes,
    postShiftWorkedMinutes,
    fullRegularShift,
    overtimeSessionCount: intervals.filter(it => !it.open && new Date(it.out) > shiftEndBoundary).length,
    autoCheckoutOvertimeMinutes,
    verifiedOvertimeMinutes: Math.max(0, overtimeMinutes - autoCheckoutOvertimeMinutes),
    unverifiedOvertimeMinutes: Math.min(overtimeMinutes, autoCheckoutOvertimeMinutes),
    sequenceAnomalies,
    requiresAttendanceReview: sequenceAnomalies.length > 0 || hasOpenInterval,
    creditedMinutes,
    separateAdjustmentMinutes,
    effectiveWorkedMinutes,
    missingHoursCompensationMinutes,
    transferredInMinutes,
    transferredOutMinutes: 0, // filled by report-builder from approved source-day transfers
    availableOvertimeMinutes: overtimeMinutes, // admin approval of transfer verifies auto-closed sessions
    approvedCompensations: approvedCompensations.map(c => ({ id: c._id, type: c.type,
      creditMode: c.creditMode || 'MERGE', countTowardsMissingHours: c.countTowardsMissingHours === true,
      minutes: c.minutes, sourceDate: c.sourceDate })),

    breakMinutes,

    rawLateMinutes,

    lateCompensationMinutes,

    lateCompensationReason:
      [firstInPunch?.lateCompensationReason, ...approvedCompensations.filter(c => c.type === 'LATE_ARRIVAL' && c.creditMode !== 'SEPARATE').map(c => c.reason)].filter(Boolean).join(' | '),

    lateCompensatedAt:
      firstInPunch?.lateCompensatedAt || null,

    lateCompensatedBy:
      firstInPunch?.lateCompensatedBy || null,

    lateMinutes,

    lateByRule,
    lateCutoffTime: shift?.startTime ? lateCutoff.toTimeString().slice(0, 5) : (attendanceRule.lateAfterTime || '09:30'),
    consecutiveLateCount: 0,
    latePenaltyApplied: false,

    earlyDepartureMinutes,

    overtimeMinutes,

    requiredMinutes: Number(
      shift?.requiredMinutes ?? attendanceRule.fullDayMinutes ?? 480
    ),

    shiftAssignment: shiftContext?.assignment ? {
      id: shiftContext.assignment._id,
      type: shiftContext.assignment.assignmentType,
      date: shiftContext.assignment.date || null,
      startDate: shiftContext.assignment.startDate || null,
      endDate: shiftContext.assignment.endDate || null,
      recurringDays: shiftContext.assignment.recurringDays || [],
      notes: shiftContext.assignment.notes || ''
    } : null,
    shiftSource: shiftContext?.source || null,

    shift: shift
      ? {
          id: shift._id,
          name: shift.name,
          startTime: shift.startTime,
          endTime: shift.endTime,
          breakMinutes:
            Number(
              shift.breakMinutes || 0
            ),
          requiredMinutes:
            Number(
              shift.requiredMinutes ?? 480
            ),
          attendanceUnits: Number(shift.attendanceUnits ?? 1),
          graceMinutes:
            Number(
              shift.graceMinutes || 0
            )
        }
      : null
  };
}


// ============================================================
// ATTENDANCE QUERY FOR EMPLOYEE
//
// IMPORTANT:
//
// Older records may contain:
//
// employeeId = EMP001
//
// while raw F28 synced records may contain:
//
// userId = 1
//
// and Employee.deviceUserId = "1"
//
// Therefore we search BOTH.
// ============================================================

async function getEmployeeAttendance(
  employee,
  fromDate,
  endDate
) {
  const or = [
    {
      employeeId:
        employee.employeeId
    }
  ];

  if (
    employee.deviceUserId !==
      undefined &&
    employee.deviceUserId !==
      null &&
    String(employee.deviceUserId)
      .trim() !== ''
  ) {
    or.push({
      userId:
        String(employee.deviceUserId)
    });
  }

  if (
    employee.deviceUid !==
      undefined &&
    employee.deviceUid !==
      null
  ) {
    or.push({
      userId:
        String(employee.deviceUid)
    });
  }

  const punches = await Attendance
    .find({
      $or: or,

      timestamp: {
        $gte: fromDate,
        $lt: endDate
      }
    })
    .sort({
      timestamp: 1
    })
    .lean();

  return punches;
}


// Optional, request-scoped performance diagnostics. No employee PII or credentials.
const reportDiagnosticsEnabled = () =>
  String(process.env.REPORT_DIAGNOSTICS || '').toLowerCase() === 'true';

let reportDiagnosticSequence = 0;
function reportDiagnosticLog(id, message) {
  if (reportDiagnosticsEnabled()) console.log(`[REPORT ${id}] ${message}`);
}

// Compensation.date and Compensation.sourceDate are stored as local
// YYYY-MM-DD strings. The general-purpose dateKey() returns an ISO timestamp
// and MUST NOT be used to compare or join these string fields.
function compensationDateKey(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = startOfDay(value);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-');
}

// ============================================================
// BUILD REPORT
// ============================================================

async function buildReport({
  from,
  to,
  employeeId,
  employeeIds
} = {}) {
  const reportId = ++reportDiagnosticSequence;
  const reportStartedAt = Date.now();
  reportDiagnosticLog(reportId, 'START buildReport');

  const fromDate =
    startOfDay(
      from || new Date()
    );

  const toDate =
    startOfDay(
      to || fromDate
    );

  const endDate =
    endOfDay(toDate);

  const ruleStartedAt = Date.now();
  const attendanceRule = (await Rule.findOne().lean()) || {};
  reportDiagnosticLog(reportId,
    `Rule.findOne: ${Date.now() - ruleStartedAt}ms`);
  const lateThreshold = Math.max(1, Number(attendanceRule.consecutiveLateThreshold || 4));
  const lookbackDays = Math.max(30, lateThreshold * 10);
  const queryStartDate = startOfDay(fromDate);
  queryStartDate.setDate(queryStartDate.getDate() - lookbackDays);

  // ----------------------------------------------------------
  // Employee filter
  // ----------------------------------------------------------

  let employeeFilter;

  if (employeeId) {
    employeeFilter = {
      employeeId: String(employeeId),
    };
  } else if (Array.isArray(employeeIds)) {
    employeeFilter = {
      active: true,
      employeeId: {
        $in: employeeIds.map((id) => String(id)),
      },
    };
  } else {
    employeeFilter = {
      active: true,
    };
  }

  const employeesStartedAt = Date.now();
  const employees =
    await Employee
      .find(employeeFilter)
      .sort({
        employeeId: 1
      })
      .lean();

  reportDiagnosticLog(reportId,
    `Employee.find: ${Date.now() - employeesStartedAt}ms; count=${employees.length}; days=${iterateDays(queryStartDate, toDate).length}`);

  const compensationEmployeeIds = employees.map(e => e.employeeId);
  const approved = compensationEmployeeIds.length ? await Compensation.find({
    employeeId: { $in: compensationEmployeeIds }, status: 'APPROVED',
    $or: [ { date: { $gte: compensationDateKey(queryStartDate), $lte: compensationDateKey(toDate) } },
           { type: 'EXTRA_HOURS_TRANSFER', sourceDate: { $gte: compensationDateKey(queryStartDate), $lte: compensationDateKey(toDate) } } ]
  }).lean() : [];
  const creditsByDay = new Map();
  const transferOutByDay = new Map();
  for (const c of approved) {
    const key = `${c.employeeId}|${compensationDateKey(c.date)}`;
    if (!creditsByDay.has(key)) creditsByDay.set(key, []);
    creditsByDay.get(key).push(c);
    if (c.type === 'EXTRA_HOURS_TRANSFER') {
      const sourceKey = `${c.employeeId}|${compensationDateKey(c.sourceDate)}`;
      transferOutByDay.set(sourceKey, (transferOutByDay.get(sourceKey) || 0) + c.minutes);
    }
  }
  const rows = [];

  // ----------------------------------------------------------
  // Build each employee
  // ----------------------------------------------------------

  for (const employee of employees) {
    const employeeStartedAt = Date.now();
    const punchStartedAt = Date.now();
    reportDiagnosticLog(reportId, `START employee ${employee.employeeId}`);
    const punches =
      await getEmployeeAttendance(
        employee,
        queryStartDate,
        endDate
      );
    reportDiagnosticLog(reportId,
      `employee ${employee.employeeId} punches: ${Date.now() - punchStartedAt}ms; count=${punches.length}`);

    const leavesStartedAt = Date.now();
    const leaves =
      await Leave.find({
        employeeId:
          employee.employeeId,

        $or: [
          { fromDate: { $lt: endDate }, toDate: { $gte: queryStartDate } },
          { fromDate: null, date: { $gte: queryStartDate, $lt: endDate } }
        ],
        approved: true
      })
      .lean();
    reportDiagnosticLog(reportId,
      `employee ${employee.employeeId} leaves: ${Date.now() - leavesStartedAt}ms; count=${leaves.length}`);

    // --------------------------------------------------------
    // Group punches by day
    // --------------------------------------------------------

    const punchesByDay =
      new Map();

    for (const punch of punches) {
      if (!punch.timestamp) {
        continue;
      }

      const key =
        dateKey(
          punch.timestamp
        );

      if (
        !punchesByDay.has(key)
      ) {
        punchesByDay.set(
          key,
          []
        );
      }

      punchesByDay
        .get(key)
        .push(punch);
    }

    // --------------------------------------------------------
    // Group leaves by day
    // --------------------------------------------------------

    const leaveByDay =
      new Map();

    const employeeHolidays = (await listActiveHolidays(queryStartDate, toDate, employee));
    const holidayByDay = new Map();
    for (const d of iterateDays(queryStartDate, toDate)) {
      const applicable = employeeHolidays.find(h => employeeHolidayEligible(h, employee) && holidayOccursOn(h, d));
      if (applicable) holidayByDay.set(dateKey(d), applicable);
    }
    for (const leave of leaves) {
      if (!leave.date) continue;
      const first = startOfDay(leave.fromDate || leave.date);
      const last = startOfDay(leave.toDate || leave.date);
      for (const d of iterateDays(first, last)) {
        // Leave does not override employee holidays or non-chargeable weekends.
        if (holidayByDay.has(dateKey(d)) && leave.policySnapshot?.includeHolidaysInLeaveDays !== true) continue;
        if ([0, 6].includes(d.getDay()) && leave.policySnapshot?.includeWeekendsInLeaveDays !== true) continue;
        leaveByDay.set(dateKey(d), leave);
      }
    }

    // --------------------------------------------------------
    // Generate every day. Keep a lookback window so a one-day report can
    // still know whether today is the 4th consecutive late working day.
    // --------------------------------------------------------

    // Preload assignment and shift data once per employee. No attendance
    // writes are performed; daily classification rules are unchanged.
    const shiftPreloadStartedAt = Date.now();
    const resolveShift = await createReportShiftResolver(employee, attendanceRule);
    reportDiagnosticLog(reportId,
      `employee ${employee.employeeId} shift preload: ${Date.now() - shiftPreloadStartedAt}ms`);

    let lateStreak = 0;
    let shiftLookupMs = 0;
    let shiftLookupCount = 0;

    for (
      const date of iterateDays(
        queryStartDate,
        toDate
      )
    ) {
      const key =
        dateKey(date);

      const dayPunches =
        punchesByDay.get(key) ||
        [];

      const leave =
        leaveByDay.get(key) ||
        null;

      const shiftStartedAt = Date.now();
      const shiftContext = resolveShift(date);
      const shiftElapsedMs = Date.now() - shiftStartedAt;
      shiftLookupMs += shiftElapsedMs;
      shiftLookupCount++;
      if (shiftElapsedMs > 500) {
        reportDiagnosticLog(reportId,
          `SLOW shift lookup ${employee.employeeId} ${dateKey(date)}: ${shiftElapsedMs}ms`);
      }
      const row = makeDaySummary(
        date,
        dayPunches,
        employee,
        shiftContext.shift,
        leave,
        attendanceRule,
        shiftContext,
        creditsByDay.get(`${employee.employeeId}|${compensationDateKey(date)}`) || [],
        holidayByDay.get(key) || null
      );
      row.transferredOutMinutes = transferOutByDay.get(`${employee.employeeId}|${compensationDateKey(date)}`) || 0;
      row.availableOvertimeMinutes = Math.max(0, row.overtimeMinutes - row.transferredOutMinutes);

      // OFF days (for example Sunday) do not break a late-arrival streak.
      if (row.status === 'PRESENT' && row.lateByRule) {
        lateStreak += 1;
        row.consecutiveLateCount = lateStreak;
        if (attendanceRule.halfDayEnabled !== false && lateStreak >= lateThreshold) {
          row.latePenaltyApplied = true;
          row.attendanceDayStatus = 'HALF_DAY';
          row.attendanceDayLabel = `Half Day (${lateThreshold} consecutive late arrivals)`;
          row.attendanceUnits = Math.min(Number(row.attendanceUnits || 1), Number(attendanceRule.consecutiveLatePenaltyUnits ?? 0.5));
          row.halfDay = true;
          row.fullDay = false;
          lateStreak = 0;
        }
      } else if (!['OFF', 'HOLIDAY'].includes(row.status)) {
        lateStreak = 0;
      }

      if (date >= fromDate) rows.push(row);
    }
    reportDiagnosticLog(reportId,
      `DONE employee ${employee.employeeId}: total=${Date.now() - employeeStartedAt}ms; shiftLookups=${shiftLookupCount}; shiftTotal=${shiftLookupMs}ms`);
  }

  reportDiagnosticLog(reportId,
    `DONE buildReport: total=${Date.now() - reportStartedAt}ms; outputRows=${rows.length}`);
  return rows;
}


// ============================================================
// AGGREGATE
// ============================================================

function aggregate(rows) {
  const safeRows =
    Array.isArray(rows)
      ? rows
      : [];

  const workingRows =
    safeRows.filter(
      (row) =>
        row.status !== 'OFF' && row.status !== 'HOLIDAY'
    );

  const presentRows =
    workingRows.filter(
      (row) =>
        row.status === 'PRESENT'
    );

  const absentRows =
    workingRows.filter(
      (row) =>
        row.status === 'ABSENT'
    );

  const leaveRows =
    workingRows.filter(
      (row) =>
        row.status === 'LEAVE'
    );

  const totalWorkingMinutes =
    presentRows.reduce(
      (sum, row) =>
        sum +
        Number(
          row.workedMinutes || 0
        ),
      0
    );

  const totalCreditedMinutes = safeRows.reduce((sum, row) => sum + Number(row.creditedMinutes || 0), 0);
  const totalEffectiveWorkingMinutes = safeRows.reduce((sum, row) => sum + Number(row.effectiveWorkedMinutes || row.workedMinutes || 0), 0);
  const totalTransferredOutMinutes = safeRows.reduce((sum, row) => sum + Number(row.transferredOutMinutes || 0), 0);
  const totalAvailableOvertimeMinutes = safeRows.reduce((sum, row) => sum + Number(row.availableOvertimeMinutes || 0), 0);
  const totalLateCompensationMinutes = safeRows.reduce((sum, row) => sum + Number(row.lateCompensationMinutes || 0), 0);
  const totalOvertimeMinutes =
    presentRows.reduce(
      (sum, row) =>
        sum +
        Number(
          row.overtimeMinutes || 0
        ),
      0
    );

  const totalBreakMinutes =
    presentRows.reduce(
      (sum, row) =>
        sum +
        Number(
          row.breakMinutes || 0
        ),
      0
    );

  const lateDays =
    presentRows.filter(
      (row) =>
        Number(
          row.lateMinutes || 0
        ) > 0
    ).length;

  const earlyCheckoutDays =
    presentRows.filter(
      (row) =>
        Number(
          row.earlyDepartureMinutes ||
            0
        ) > 0
    ).length;

  const halfDayRows = presentRows.filter(row => row.attendanceDayStatus === 'HALF_DAY');
  const fullDayRows = presentRows.filter(row => row.attendanceDayStatus === 'FULL_DAY');
  const incompleteRows = presentRows.filter(row => row.attendanceDayStatus === 'INCOMPLETE' || row.attendanceDayStatus === 'IN_PROGRESS');
  const attendanceEquivalentDays = presentRows.reduce(
    (sum, row) => sum + Number(row.attendanceUnits || 0),
    0
  );

  return {
    totalRows:
      safeRows.length,

    totalWorkingDays:
      workingRows.length,

    presentDays:
      presentRows.length,

    // Attendance equivalent: 2 half-day records = 1 full day.
    attendanceEquivalentDays,
    halfDayDays: halfDayRows.length,
    fullDayDays: fullDayRows.length,
    incompleteAttendanceDays: incompleteRows.length,

    absentDays:
      absentRows.length,

    leaveDays:
      leaveRows.length,

    offDays:
      safeRows.filter(
        (row) =>
          row.status === 'OFF'
      ).length,

    lateDays,

    earlyCheckoutDays,

    totalWorkingMinutes,
    totalCreditedMinutes,
    totalEffectiveWorkingMinutes,
    totalTransferredOutMinutes,
    totalAvailableOvertimeMinutes,
    totalLateCompensationMinutes,

    totalBreakMinutes,

    totalOvertimeMinutes,

    averageWorkingMinutes:
      presentRows.length > 0
        ? Math.round(
            totalWorkingMinutes /
              presentRows.length
          )
        : 0,

    averageOvertimeMinutes:
      presentRows.length > 0
        ? Math.round(
            totalOvertimeMinutes /
              presentRows.length
          )
        : 0
  };
}



module.exports = {
  buildReport,
  compensationDateKey,
  aggregate,
  makeDaySummary,
  getEmployeeShift,
  getEmployeeAttendance
};