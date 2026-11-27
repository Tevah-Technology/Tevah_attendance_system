const { withAttendanceDisplay } = require('../utils/attendance-time-display');
const crypto = require('crypto');
const { config, createDevice } = require('../config/zkteco');
const { Attendance, Employee, Shift, Rule, RejectedPunch, EmployeePunchLock } = require('../models');
const { stateToPunchType, verificationLabel, attendanceStateLabel } = require('../utils/punches');
const { startOfDay, endOfDay } = require('../utils/time');
const {employeeLabel,atLabel,groupPunches}=require('../utils/employee-time');
const {effectiveRule}=require('./employee-rule.service');
const { getAttendancePolicy, classifyDay } = require('../utils/attendance-policy');
const { getEffectiveShift, getDefaultShift } = require('./shift-assignment.service');

let broadcaster = null;

function setBroadcaster(fn) { broadcaster = fn; }

function makeSessionId() {
  return crypto.randomUUID();
}

function normalizeLog(log) {
  const timestamp = new Date(log.recordTime ?? log.attTime ?? log.timestamp);
  return {
    userId: String(log.deviceUserId ?? log.userId ?? log.userid ?? log.userSn ?? '').trim(),
    userSn: log.userSn == null ? null : Number(log.userSn),
    timestamp,
    state: log.attState ?? log.inOutStatus ?? log.state ?? log.status ?? null,
    attendanceState: log.attState ?? log.inOutStatus ?? log.state ?? null,
    verificationMode: log.verifyMode ?? log.verificationMode ?? log.verify ?? null,
    verificationLabel: verificationLabel(log.verifyMode ?? log.verificationMode ?? log.verify),
    workCode: log.workCode ?? null,
    rawRecordHex: log.rawRecordHex ?? null,
    rawData: log
  };
}

async function getEmployeeByDevice(userId, userSn) {
  const value = String(userId ?? '').trim();
  const employeeQuery = [];

  if (value) {
    employeeQuery.push({ deviceUserId: value });
    employeeQuery.push({ employeeId: value });
  }

  // Some F28 firmware stores the numeric terminal UID/PIN in the
  // attendance record even though the Users table exposes a different
  // employee ID (for example: attendance value "4" -> UID 4 -> EMP003).
  if (/^\d+$/.test(value)) {
    employeeQuery.push({ deviceUid: Number(value) });
  }

  if (!employeeQuery.length) return null;
  return Employee.findOne({ $or: employeeQuery }).lean();
}

async function getEmployeeShift(employee) {
  return getDefaultShift(employee);
}

async function getRule(employee = null, at = null) {
  let rule = await Rule.findOne().lean();
  if (!rule) rule = (await Rule.create({})).toObject();
  return employee ? effectiveRule(employee,rule,at) : rule;
}

function timeOnDate(date, hhmm) {
  const d = startOfDay(date);
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  d.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0);
  return d;
}

async function getShiftBoundaries(employee, timestamp, rule = null) {
  rule = rule || await getRule(employee,timestamp);
  const at = new Date(timestamp);
  const effective = employee?.employeeId ? await getEffectiveShift(employee, at) : null;
  const shift = effective?.shift || null;
  if (shift?.shiftType === 'WORKING_HOURS_ONLY') return { shift, shiftSource: effective?.source, shiftStart: null, shiftEnd: null, lunchStart: null, lunchEnd: null, lunchValid: false };
  const day = employeeLabel(at,employee);
  const shiftStart = atLabel(day,shift?.startTime || rule.morningStartTime || '09:00',employee);
  let shiftEnd = atLabel(day,shift?.endTime || rule.dayEndAutoCheckoutTime || '17:30',employee);
  if (shiftEnd <= shiftStart) shiftEnd=atLabel(day,shift?.endTime || rule.dayEndAutoCheckoutTime || '17:30',employee,1);
  const lunchStart = atLabel(day,shift?.lunchStartTime || rule.middayAutoCheckoutTime || '13:00',employee);
  const lunchEnd = atLabel(day,shift?.lunchEndTime || rule.afternoonStartTime || '13:30',employee);
  const lunchValid = lunchStart > shiftStart && lunchEnd > lunchStart && lunchEnd < shiftEnd;
  return { shift, shiftSource: effective?.source || null, shiftStart, shiftEnd, lunchStart, lunchEnd, lunchValid };
}

async function getScheduledCheckoutAt(timestamp, employee = null) {
  const rule = await getRule(employee,timestamp);
  const punchAt = new Date(timestamp);
  const t = await getShiftBoundaries(employee, punchAt, rule);
  if (t.shift?.shiftType === 'WORKING_HOURS_ONLY') {
    const limit = Number(t.shift.maximumSessionMinutes || 0);
    return limit > 0 ? new Date(punchAt.getTime() + limit * 60000) : null;
  }
  // Overtime re-entry after the regular shift is limited independently.
  if (rule.overtimeAutoCheckoutEnabled && punchAt >= t.shiftEnd) {
    return new Date(punchAt.getTime() + Number(rule.overtimeSessionLimitMinutes || 120) * 60000);
  }
  if (!rule.autoCheckoutEnabled) return null;
  if (rule.noonAutoCheckoutEnabled !== false && t.lunchValid && punchAt < t.lunchStart)
    return t.lunchStart;
  if (rule.shiftEndAutoCheckoutEnabled || (employee?.timezone && t.shift) || ['single_date','date_range','recurring'].includes(t.shiftSource)) {
    if (punchAt < t.shiftEnd) return t.shiftEnd;
  } else {
    const legacyEnd = atLabel(employeeLabel(punchAt,employee),rule.dayEndAutoCheckoutTime || '17:30',employee);
    if (punchAt < legacyEnd) return legacyEnd;
  }
  return null;
}

async function isBlockedLunchIn(employee, timestamp) {
  const rule = await getRule(employee,timestamp);
  if (!rule.lunchClockInBlocked) return false;
  const boundaries = await getShiftBoundaries(employee, timestamp, rule);
  const at = new Date(timestamp);
  return boundaries.lunchValid && at >= boundaries.lunchStart && at < boundaries.lunchEnd;
}

async function getRequiredMinutes(employee, date = new Date()) {
  const rule = await getRule(employee,date);

  // Legacy-compatible flag name, but the value now comes from /api/rules.
  // true  -> use Rules.fullDayMinutes
  // false -> use the employee/default shift requiredMinutes
  const effective = await getEffectiveShift(employee, date);
  if (effective?.shift?.shiftType === 'WORKING_HOURS_ONLY') return Math.max(1, Number(effective.shift.requiredMinutes || 480));
  if (rule.attendanceUseEnvHours === true) {
    const configured = Number(rule.fullDayMinutes ?? 480);
    return Math.max(1, Number.isFinite(configured) ? configured : 480);
  }

  const required = Number(effective?.shift?.requiredMinutes ?? rule.fullDayMinutes ?? 480);
  return Math.max(1, Number.isFinite(required) ? required : 480);
}

async function getLatestEmployeePunch(employeeId, before = null) {
  const filter = { employeeId: String(employeeId) };
  if (before) filter.timestamp = { $lt: before };
  return Attendance.findOne(filter).sort({ timestamp: -1, _id: -1 }).lean();
}

function isActivePunch(punch) {
  return punch && punch.punchType === 'IN';
}

async function emit(record) {
  if (broadcaster) {
    try { broadcaster(record.toObject ? record.toObject() : record); } catch (error) {
      console.error('Attendance broadcaster error:', error.message);
    }
  }
}

// Guards state transitions across multiple PM2 workers and schedulers.
// A failed lock must not silently discard terminal data: polling will retry it.
async function withPunchLock(employeeId, callback) {
  const owner = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30000);
  try {
    await EmployeePunchLock.findOneAndUpdate(
      { employeeId: String(employeeId), expiresAt: { $lte: now } },
      { $set: { owner, expiresAt }, $setOnInsert: { employeeId: String(employeeId) } },
      { upsert: true, new: true, runValidators: true }
    );
  } catch (err) {
    if (err.code === 11000) {
      const busy = new Error('Employee attendance is being updated; retry');
      busy.statusCode = 409;
      throw busy;
    }
    throw err;
  }
  try { return await callback(); }
  finally { await EmployeePunchLock.deleteOne({ employeeId: String(employeeId), owner }); }
}

async function createPunch(args) {
  if (!args?.employee?.employeeId) throw new Error('Employee profile is required');
  return withPunchLock(args.employee.employeeId, () => createPunchUnlocked(args));
}

async function createPunchUnlocked({
  employee,
  punchType,
  timestamp = new Date(),
  source = 'WEB',
  state = null,
  rawData = null,
  userId = null,
  userSn = null,
  sessionId = '',
  isAutoCheckout = false,
  force = false,
  attendanceState = null,
  verificationMode = null,
  verificationLabelText = '',
  workCode = null,
  rawRecordHex = null,
  explicitPunchType = null,
  allowDeviceSequence = false
}) {
  if (!employee?.employeeId) throw new Error('Employee profile is required');

  const employeeId = String(employee.employeeId);
  if (punchType === 'IN' && await isBlockedLunchIn(employee, timestamp)) {
    return { blocked: true, reason: 'LUNCH_CLOCK_IN_BLOCKED', timestamp: new Date(timestamp) };
  }
  const resolvedUserId = String(userId ?? employee.deviceUserId ?? employeeId);
  const previous = await getLatestEmployeePunch(employeeId);
  const active = isActivePunch(previous);

  // Web/manual actions enforce an open-session rule. Device imports do not:
  // every F28 punch is a real terminal event and must be persisted, even when
  // the terminal produced consecutive IN/OUT-like events or when historical
  // records are being replayed after the backend was offline.
  if (!allowDeviceSequence) {
    if (!force && punchType === 'IN' && active) {
      return { alreadyCheckedIn: true, record: previous };
    }

    if (!force && punchType === 'OUT' && !active) {
      return { notCheckedIn: true, record: previous || null };
    }
  }

  punchType = explicitPunchType || punchType;

  let resolvedSessionId = sessionId;
  let autoCheckoutAt = null;

  if (punchType === 'IN') {
    // Every IN starts a fresh session. Auto-checkout is tied to the configured
    // workday boundary (13:00 or 17:30), not to a duration from first check-in.
    resolvedSessionId = resolvedSessionId || makeSessionId();
    autoCheckoutAt = await getScheduledCheckoutAt(timestamp, employee);
  } else {
    resolvedSessionId = resolvedSessionId || previous?.sessionId || makeSessionId();
  }

  const recordData = {
    deviceIp: source === 'DEVICE' ? config.ip : ['AUTO','AUTO_LUNCH_RETURN'].includes(source) ? 'SYSTEM' : 'WEB',
    userId: resolvedUserId,
    userSn: userSn == null ? (employee.deviceUid ?? null) : userSn,
    employeeId,
    employeeName: employee.name || '',
    timestamp,
    punchType,
    state,
    attendanceState: attendanceState == null ? state : attendanceState,
    verificationMode,
    verificationLabel: verificationLabelText || verificationLabel(verificationMode),
    workCode,
    rawRecordHex,
    rawData,
    source,
    autoCheckoutAt,
    sessionId: resolvedSessionId,
    isAutoCheckout: Boolean(isAutoCheckout),
    autoEventKey: isAutoCheckout && rawData?.closedFromAttendanceId
      ? `AUTO_OUT:${String(rawData.closedFromAttendanceId)}`
      : source === 'AUTO_LUNCH_RETURN'
        ? `AUTO_LUNCH_RETURN:${employeeId}:${new Date(timestamp).toISOString()}`
        : null
  };

  try {
    const record = await Attendance.create(recordData);
    await emit(record);
    return { inserted: true, record: record.toObject() };
  } catch (error) {
    if (error.code === 11000) {
      const duplicate = await Attendance.findOne(recordData.autoEventKey
        ? { $or: [{ autoEventKey: recordData.autoEventKey }, {
            deviceIp: recordData.deviceIp, userId: recordData.userId, timestamp: recordData.timestamp
          }] }
        : { deviceIp: recordData.deviceIp, userId: recordData.userId, timestamp: recordData.timestamp }
      ).lean();
      return { duplicate: true, record: duplicate };
    }
    throw error;
  }
}

async function saveAttendanceLog(rawLog, options = {}) {
  const normalized = normalizeLog(rawLog);
  if (!normalized.userId || Number.isNaN(normalized.timestamp.getTime())) return { skipped: 1 };

  const employee = await getEmployeeByDevice(normalized.userId, normalized.userSn);
  const employeeId = employee?.employeeId || normalized.userId;

  // Merge F28 and web/AUTO events into one chronological state machine.
  // Explicit F28 states win. If the terminal does not provide a reliable
  // state, infer IN/OUT from the latest event before this timestamp, including
  // web and automatic punches.
  const hasExplicitState = normalized.state !== null && normalized.state !== undefined && normalized.state !== '' && Number.isFinite(Number(normalized.state));
  let punchType = options.punchType || null;
  if (!punchType && hasExplicitState) punchType = stateToPunchType(normalized.state, 0);
  if (!punchType) {
    const laterAtTime = await Attendance.exists({ employeeId, timestamp: { $gt: normalized.timestamp } });
    if (laterAtTime) {
      // Don't guess whether a delayed terminal punch is IN or OUT after
      // synthetic/checkpoint punches exist. Preserve raw evidence for review.
      punchType = 'UNKNOWN';
    } else {
      const previousAtTime = await getLatestEmployeePunch(employeeId, normalized.timestamp);
      punchType = previousAtTime?.punchType === 'IN' ? 'OUT' : 'IN';
    }
  }

  if (!employee) {
    console.warn(`F28 punch received for unlinked user ${normalized.userId}; saving it as employee ${employeeId}`);
  }

  if (punchType === 'IN' && await isBlockedLunchIn(employee || { employeeId }, normalized.timestamp)) {
    try {
      await RejectedPunch.updateOne(
        { deviceIp: config.ip, userId: normalized.userId, timestamp: normalized.timestamp },
        { $setOnInsert: { deviceIp: config.ip, userId: normalized.userId,
          employeeId, timestamp: normalized.timestamp, attemptedPunchType: 'IN',
          reason: 'LUNCH_CLOCK_IN_BLOCKED', rawData: normalized.rawData } }, { upsert: true });
    } catch (error) { if (error.code !== 11000) throw error; }
    return { skipped: 1, blocked: true, reason: 'LUNCH_CLOCK_IN_BLOCKED' };
  }

  return createPunch({
    employee: employee || { employeeId, name: '' },
    punchType,
    explicitPunchType: punchType,
    allowDeviceSequence: true,
    timestamp: normalized.timestamp,
    source: 'DEVICE',
    state: normalized.state,
    attendanceState: normalized.attendanceState,
    verificationMode: normalized.verificationMode,
    verificationLabelText: normalized.verificationLabel,
    workCode: normalized.workCode,
    rawRecordHex: normalized.rawRecordHex,
    rawData: normalized.rawData,
    userId: normalized.userId,
    userSn: normalized.userSn
  });
}

async function webCheckIn(employeeId, metadata = {}) {
  const employee = await Employee.findOne({ employeeId: String(employeeId), active: true }).lean();
  if (!employee) throw new Error('Active employee profile not found');

  // Catch up an overdue scheduled checkout for this employee before deciding
  // whether today's new IN is a duplicate. The periodic scheduler may not have
  // run yet, e.g. immediately after a server restart.
  const lastPunch = await getLatestEmployeePunch(employee.employeeId);
  if (isActivePunch(lastPunch)) {
    const due = await getScheduledCheckoutAt(lastPunch.timestamp, employee);
    if (due && due <= new Date()) {
      await createPunch({
        employee, punchType: 'OUT', timestamp: due, source: 'AUTO',
        sessionId: lastPunch.sessionId, isAutoCheckout: true, force: true,
        rawData: { source: 'AUTO_CHECKOUT', reason: 'Overdue scheduled checkout reconciled before web check-in', closedFromAttendanceId: String(lastPunch._id) }
      });
    }
  }

  if (await isBlockedLunchIn(employee, new Date())) {
    const error = new Error('Clock-in is not allowed during the configured lunch break');
    error.statusCode = 409;
    throw error;
  }
  return createPunch({
    employee,
    punchType: 'IN',
    timestamp: new Date(),
    source: 'WEB',
    rawData: { source: 'WEB', ...(metadata || {}) },
    userId: employee.deviceUserId || employee.employeeId,
    userSn: employee.deviceUid
  });
}

async function webCheckOut(employeeId, metadata = {}) {
  const employee = await Employee.findOne({ employeeId: String(employeeId), active: true }).lean();
  if (!employee) throw new Error('Active employee profile not found');

  return createPunch({
    employee,
    punchType: 'OUT',
    timestamp: new Date(),
    source: 'WEB',
    rawData: { source: 'WEB', ...(metadata || {}) },
    userId: employee.deviceUserId || employee.employeeId,
    userSn: employee.deviceUid
  });
}

async function getTodayStatus(employeeId) {
  const employee = await Employee.findOne({ employeeId: String(employeeId) }).lean();
  if (!employee) throw new Error('Employee profile not found');

  const nowDate=new Date();
  const localDay=employeeLabel(nowDate,employee);
  const from=new Date(localDay.getTime()-3*86400000);
  const to=new Date(localDay.getTime()+3*86400000);
  const rawPunches=await Attendance.find({employeeId:employee.employeeId,timestamp:{$gte:from,$lt:to}}).sort({timestamp:1,_id:1}).lean();
  const latest=await getLatestEmployeePunch(employee.employeeId);
  const active=isActivePunch(latest);
  const attendanceRule=await getRule(employee,nowDate);
  const resolveShift=await require('./shift-assignment.service').createReportShiftResolver(employee,attendanceRule);
  const grouped=groupPunches(rawPunches,employee,resolveShift);
  let statusDay=localDay;
  if(active && latest.timestamp){const day=employeeLabel(latest.timestamp,employee);if(resolveShift(day)?.shift?.shiftType==='WORKING_HOURS_ONLY')statusDay=day;}
  const punches=grouped.get(statusDay.toISOString())||[];
  const firstIn = punches.find(p => p.punchType === 'IN') || null;
  const lastOut = [...punches].reverse().find(p => p.punchType === 'OUT') || null;

  let workingMinutes = 0;
  let openIn = null;
  const intervals = [];
  for (const punch of punches) {
    if (punch.punchType === 'IN' && !openIn) openIn = punch;
    if (punch.punchType === 'OUT' && openIn) {
      const minutes = Math.max(0, Math.round((new Date(punch.timestamp) - new Date(openIn.timestamp)) / 60000));
      workingMinutes += minutes;
      intervals.push({
        in: openIn.timestamp,
        out: punch.timestamp,
        minutes,
        inSource: openIn.source || null,
        outSource: punch.source || null,
        halfDay: false,
        fullDay: false
      });
      openIn = null;
    }
  }
  if (openIn) {
    const minutes = Math.max(0, Math.round((Date.now() - new Date(openIn.timestamp)) / 60000));
    workingMinutes += minutes;
    intervals.push({
      in: openIn.timestamp,
      out: null,
      minutes,
      inSource: openIn.source || null,
      outSource: null,
      halfDay: false,
      fullDay: false,
      open: true
    });
  }

  const currentShift = resolveShift(statusDay)?.shift;
  const hoursOnly = currentShift?.shiftType === 'WORKING_HOURS_ONLY';
  const policy = getAttendancePolicy(hoursOnly ? {...attendanceRule, halfDayEnabled:false, halfDayMinutes:0, fullDayMinutes:currentShift.requiredMinutes, twoHalfDaysEqualOneDay:false} : attendanceRule);
  const completedIntervals = intervals.filter(i => !i.open);
  const intervalClassifications = completedIntervals.map(i => classifyDay({ workedMinutes: i.minutes, completedIntervals: 1, hasOpenInterval: false }, policy));
  let halfDayCount = 0;
  let fullDayCount = 0;
  completedIntervals.forEach((interval, index) => {
    const c = intervalClassifications[index];
    interval.halfDay = c.halfDay;
    interval.fullDay = c.fullDay;
    if (c.halfDay) halfDayCount++;
    if (c.fullDay) fullDayCount++;
  });

  const dayClassification = classifyDay({
    workedMinutes: workingMinutes,
    completedIntervals: completedIntervals.length,
    hasOpenInterval: Boolean(openIn)
  }, policy);

  // Two qualifying half-day sessions on the same day are a full attendance
  // day. A split day such as 09:00-13:00 + 14:00-18:00 therefore reports FULL_DAY.
  if (policy.halfDayEnabled && policy.twoHalfDaysEqualOneDay && halfDayCount >= 2 && dayClassification.status !== 'FULL_DAY') {
    dayClassification.status = 'FULL_DAY';
    dayClassification.label = 'Full Day';
    dayClassification.attendanceUnits = 1;
    dayClassification.halfDay = false;
    dayClassification.fullDay = true;
  }

  const requiredMinutes = await getRequiredMinutes(employee, atLabel(statusDay,'12:00',employee));
  const overtimeMinutes = (attendanceRule.overtimeEnabled === false || (hoursOnly && currentShift.enableOvertime === false)) ? 0 : Math.max(0, workingMinutes - requiredMinutes);

  // Reuse the report engine for today's final attendance credit and late-streak
  // penalty so the self-service status and reports cannot disagree.
  let reportRow = null;
  try {
    const { buildReport } = require('./report.service');
    reportRow = (await buildReport({ from: statusDay, to: statusDay, employeeId: employee.employeeId }))[0] || null;
  } catch (error) {
    console.error('Today attendance classification error:', error.message);
  }
  const boundaries = await getShiftBoundaries(employee, new Date(), attendanceRule);
  const lastPunchToday = punches.length ? punches[punches.length - 1] : null;
  const now = new Date();
  const afterLunch = boundaries.lunchValid && now >= boundaries.lunchEnd && now < boundaries.shiftEnd;
  const morningIN = punches.some(p => p.punchType === 'IN' && p.timestamp < boundaries.lunchStart);
  const lunchReturnWarning = afterLunch && morningIN && !active;
  const overtimeSessionActive = !hoursOnly && active && lastPunchToday?.punchType === 'IN' &&
    new Date(lastPunchToday.timestamp) >= boundaries.shiftEnd;
  return withAttendanceDisplay({
    employeeId: employee.employeeId,
    attendanceDate: require('../utils/employee-time').labelKey(statusDay),
    timezone: employee.timezone || null,
    lunchReturnWarning,
    lunchReturnWarningText: lunchReturnWarning ? 'You have not clocked in after lunch. Please clock in to resume work.' : null,
    regularShiftEnd: boundaries.shiftEnd,
    overtimeSessionActive,
    overtimeAutoCheckoutAt: overtimeSessionActive ? (latest?.autoCheckoutAt || null) : null,
    attendanceNotice: overtimeSessionActive ? 'Overtime active. Your session will close at its configured limit.' :
      !hoursOnly && now >= boundaries.shiftEnd ? 'Your regular shift has ended. Clock in again if you are continuing overtime.' : null,
    employeeName: employee.name,
    checkedIn: active,
    status: active ? 'IN_OFFICE' : (punches.length ? 'CHECKED_OUT' : 'NOT_CHECKED_IN'),
    attendanceDayStatus: reportRow?.attendanceDayStatus || dayClassification.status,
    attendanceDayLabel: reportRow?.attendanceDayLabel || dayClassification.label,
    attendanceUnits: reportRow?.attendanceUnits ?? dayClassification.attendanceUnits,
    halfDay: reportRow?.halfDay ?? dayClassification.halfDay,
    fullDay: reportRow?.fullDay ?? dayClassification.fullDay,
    halfDayEligible: dayClassification.halfDayEligible,
    halfDaySessions: halfDayCount,
    fullDaySessions: fullDayCount,
    firstIn: firstIn?.timestamp || null,
    lastOut: lastOut?.timestamp || null,
    workingMinutes,
    requiredMinutes: reportRow?.requiredMinutes ?? requiredMinutes,
    overtimeMinutes: reportRow?.overtimeMinutes ?? overtimeMinutes,
    employeeExceptions: reportRow?.employeeExceptions || [],
    intervals,
    punches,
    activePunch: active ? latest : null,
    autoCheckoutAt: active ? (latest.autoCheckoutAt || null) : null,
    lateByRule: reportRow?.lateByRule || false,
    consecutiveLateCount: reportRow?.consecutiveLateCount || 0,
    latePenaltyApplied: reportRow?.latePenaltyApplied || false,
    attendancePolicy: policy,
    attendanceRule
  });
}
// Refresh only the latest punch for each employee; do not update already-closed sessions.
// A changed noon toggle takes effect without restarting the backend.
async function rescheduleOpenSessions() {
  const rule = await getRule();
  const latest = await Attendance.aggregate([
    { $sort: { employeeId: 1, timestamp: -1, _id: -1 } },
    { $group: { _id: '$employeeId', punch: { $first: '$$ROOT' } } },
    { $match: { 'punch.punchType': 'IN' } }
  ]);
  let updated = 0;
  for (const row of latest) {
    const employee = await Employee.findOne({ employeeId: row._id, active: true }).lean();
    if (!employee) continue;
    const due = await getScheduledCheckoutAt(row.punch.timestamp, employee);
    await Attendance.updateOne({ _id: row.punch._id }, { $set: { autoCheckoutAt: due } });
    updated++;
  }
  return { updated };
}

async function autoCheckoutOpenSessions(now = new Date()) {
  const rule = await getRule();
  // Per-shift session limits can remain enabled independently of company timing rules.

  const candidates = await Attendance.find({
    punchType: 'IN',
    autoCheckoutAt: { $ne: null, $lte: now }
  }).sort({ employeeId: 1, timestamp: -1, _id: -1 }).lean();

  const latestByEmployee = new Map();
  for (const candidate of candidates) {
    if (!latestByEmployee.has(candidate.employeeId)) latestByEmployee.set(candidate.employeeId, candidate);
  }

  let checkedOut = 0;
  let skipped = 0;

  for (const [employeeId, openPunch] of latestByEmployee) {
    const latest = await getLatestEmployeePunch(employeeId);
    if (!latest || latest._id.toString() !== openPunch._id.toString() || latest.punchType !== 'IN') {
      skipped++;
      continue;
    }

    const employee = await Employee.findOne({ employeeId, active: true }).lean();
    if (!employee) {
      skipped++;
      continue;
    }

    const effectiveAt = await getScheduledCheckoutAt(openPunch.timestamp, employee);
    if (!effectiveAt || effectiveAt > now) {
      await Attendance.updateOne({ _id: openPunch._id }, { $set: { autoCheckoutAt: effectiveAt } });
      skipped++;
      continue;
    }

    const result = await createPunch({
      employee,
      punchType: 'OUT',
      timestamp: effectiveAt,
      source: 'AUTO',
      rawData: {
        source: 'AUTO_CHECKOUT',
        reason: 'Required working duration reached',
        closedFromAttendanceId: String(openPunch._id)
      },
      userId: employee.deviceUserId || employee.employeeId,
      userSn: employee.deviceUid,
      sessionId: openPunch.sessionId,
      isAutoCheckout: true,
      force: true
    });

    if (result.inserted) checkedOut++;
  }

  return { checkedOut, skipped, candidates: candidates.length };
}

// Scheduler runs at the system's configured lunch end. Uses the exact configured
// boundary (not the scheduler execution time) and only resumes an AUTO lunch OUT.
async function autoLunchReturn(now = new Date()) {
  const companyRule=await getRule();
  const employees = await Employee.find({ active: true }).lean();
  let inserted = 0, skipped = 0;
  for (const employee of employees) {
    const rule=await effectiveRule(employee,companyRule,now);
    if (!rule.autoLunchReturnEnabled || !rule.noonAutoCheckoutEnabled || !rule.autoCheckoutEnabled) continue;
    const t = await getShiftBoundaries(employee, now, rule);
    if (!t.lunchValid || now < t.lunchEnd || now >= t.shiftEnd) continue;
    // Catch a missed run only in the small immediate post-lunch window.
    if (now.getTime() - t.lunchEnd.getTime() > 5 * 60000) continue;
    const latest = await getLatestEmployeePunch(employee.employeeId);
    if (!latest || latest.punchType !== 'OUT' || latest.source !== 'AUTO' ||
        latest.timestamp < t.lunchStart || latest.timestamp >= t.lunchEnd) { skipped++; continue; }
    const first = await Attendance.findOne({ employeeId: employee.employeeId,
      punchType: 'IN', timestamp: { $gte: t.shiftStart, $lt: t.lunchStart } }).lean();
    if (!first) { skipped++; continue; }
    const result = await createPunch({ employee, punchType: 'IN', timestamp: t.lunchEnd,
      source: 'AUTO_LUNCH_RETURN', userId: employee.deviceUserId || employee.employeeId,
      userSn: employee.deviceUid,
      rawData: { source: 'AUTO_LUNCH_RETURN', verifiedOnSite: false,
        note: 'System-time return; not proof of biometric/geofence presence' } });
    if (result.inserted) inserted++;
  }
  return { inserted, skipped };
}

async function syncAttendance() {
  const deviceService = require('./device.service');
  const logs = await deviceService.getAttendanceLogs();

  // Always process device history in chronological order. The complete device
  // history is used to determine IN/OUT when the F28 record does not contain a
  // reliable punch-state value. This avoids using MongoDB's latest state as a
  // gate, which previously caused valid historical punches to be discarded.
  const ordered = [...logs].sort((a, b) => {
    const ta = new Date(a.recordTime ?? a.attTime ?? a.timestamp).getTime();
    const tb = new Date(b.recordTime ?? b.attTime ?? b.timestamp).getTime();
    return ta - tb;
  });

  // saveAttendanceLog reconciles state against the combined DEVICE/WEB/AUTO history.
  let inserted = 0, duplicates = 0, skipped = 0;
  const errors = [];
  for (const log of ordered) {
    try {
      const result = await saveAttendanceLog(log);
      inserted += result.inserted ? 1 : 0;
      duplicates += result.duplicate ? 1 : 0;
      skipped += result.skipped ? 1 : 0;
    } catch (error) {
      errors.push({
        userId: String(log.deviceUserId ?? log.userId ?? ''),
        timestamp: log.recordTime ?? log.attTime ?? log.timestamp ?? null,
        message: error.message
      });
      console.error('F28 attendance import error:', error.message);
    }
  }

  let info = null;
  try { info = await deviceService.getInfo(); } catch (_) {}

  return {
    totalFromDevice: ordered.length,
    inserted,
    duplicates,
    skipped,
    failed: errors.length,
    errors,
    device: info,
    deviceIp: config.ip
  };
}

async function startRealtimeListener() {
  if (String(process.env.ZK_REALTIME).toLowerCase() !== 'true') return null;
  const device = createDevice();
  try {
    await device.createSocket();
    if (typeof device.getRealTimeLogs !== 'function') {
      throw new Error('getRealTimeLogs is not available in this node-zklib build');
    }
    await device.getRealTimeLogs((log) => {
      saveAttendanceLog(log).catch((error) =>
        console.error('Realtime attendance error:', error.message));
    });
    console.log('ZKTeco real-time attendance listener started');
    return device;
  } catch (error) {
    // Prevent a half-open listener from surviving failed setup.
    try { await device.disconnect(); } catch (_) {}
    throw error;
  }
}

module.exports = {
  setBroadcaster,
  normalizeLog,
  saveAttendanceLog,
  syncAttendance,
  startRealtimeListener,
  webCheckIn,
  webCheckOut,
  getTodayStatus,
  autoCheckoutOpenSessions,
  autoLunchReturn,
  getShiftBoundaries,
  rescheduleOpenSessions,
  getEmployeeShift,
  getRequiredMinutes,
  getRule,
  getScheduledCheckoutAt
};
