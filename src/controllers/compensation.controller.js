const mongoose = require('mongoose');
const { Compensation, Employee, AuditLog, OvertimeBalance } = require('../models');
const { buildReport } = require('../services/report.service');
const { assertEmployeeAllowed, getAllowedEmployeeIds } = require('../services/access-scope.service');

const TYPES = new Set(['MISSING_HOURS', 'EXTRA_HOURS_TRANSFER', 'LATE_ARRIVAL']);
const MAX_MINUTES = { MISSING_HOURS: 720, EXTRA_HOURS_TRANSFER: 720, LATE_ARRIVAL: 240 };
const MAX_REASON = 1000;

function localDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T12:00:00`);
  return !Number.isNaN(date.getTime()) &&
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` === text ? date : null;
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function failure(res, code, message) { return res.status(code).json({ success: false, message }); }
function integerMinutes(n, type) {
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_MINUTES[type];
}
// Route middleware checks the specific compensation permission before invoking
// each handler. Do not apply a second hard-coded role allow-list here: a custom
// manager role with assigned permissions must be able to manage compensation.
function can(req, permission) {
  return req.access?.roleCode === 'SUPER_ADMIN' ||
    Boolean(req.access?.permissions?.includes(permission));
}
function normalizeBody(body) {
  const type = String(body?.type || '').trim().toUpperCase();
  const employeeId = String(body?.employeeId || '').trim();
  const date = String(body?.date || '').trim();
  const minutes = body?.minutes;
  const sourceDate = body?.sourceDate == null ? null : String(body.sourceDate).trim();
  const reason = String(body?.reason || '').trim();
  const creditMode = String(body?.creditMode || 'MERGE').trim().toUpperCase();
  if (!['MERGE', 'SEPARATE'].includes(creditMode)) throw new Error('creditMode must be MERGE or SEPARATE');
  // MERGE counts approved minutes toward the remaining required-hour shortage.
  // SEPARATE is an audited adjustment only, never physical or credited work.
  // For newly created late MERGE requests, the explicit flag below prevents
  // historical late-only MERGE approvals from being retroactively credited.
  if (!TYPES.has(type)) throw new Error('Invalid compensation type');
  if (!employeeId || employeeId.length > 100) throw new Error('Valid employeeId is required');
  if (!localDate(date) || date > today()) throw new Error('date must be a valid non-future YYYY-MM-DD date');
  if (!integerMinutes(minutes, type)) throw new Error(`minutes must be a whole number from 1 to ${MAX_MINUTES[type]}`);
  if (!reason || reason.length > MAX_REASON) throw new Error('A reason of 1–1000 characters is required');
  if (type === 'EXTRA_HOURS_TRANSFER') {
    if (!localDate(sourceDate) || sourceDate > today() || sourceDate === date) throw new Error('A valid different, non-future sourceDate is required');
  } else if (sourceDate) throw new Error('sourceDate applies only to EXTRA_HOURS_TRANSFER');
  const countsHours = creditMode === 'MERGE' &&
    (type !== 'LATE_ARRIVAL' || body?.legacyLateOnly !== true);
  return { type, employeeId, date, minutes, sourceDate, reason, creditMode,
    creditBucket: countsHours ? 'HOURS' : null,
    lateBucket: type === 'LATE_ARRIVAL' ? 'LATE' : null,
    separateBucket: creditMode === 'SEPARATE' ? type : null,
    // Only NEW explicit late MERGE approvals credit missing hours. Historical
    // late-only approvals and employee late requests remain late-only.
    countTowardsMissingHours: countsHours && type === 'LATE_ARRIVAL'
  };
}
async function visible(req, employeeId, approval = false) {
  return assertEmployeeAllowed({ ...req, access: { ...req.access, dataScope: approval ? req.access.approvalScope : req.access.dataScope } }, employeeId);
}
async function day(employeeId, date) {
  const rows = await buildReport({ from: date, to: date, employeeId });
  return rows[0] || null;
}
async function validateCredit(record) {
  const target = await day(record.employeeId, record.date);
  if (!target) throw new Error('Employee attendance report unavailable');
  if (record.type === 'LATE_ARRIVAL') {
    if (!target.firstIn) throw new Error('Late-arrival compensation requires an original IN punch');
    const remainingLate = Math.max(0, Number(target.rawLateMinutes) - Number(target.lateCompensationMinutes));
    if (record.minutes > remainingLate) {
      throw new Error('Requested late allowance exceeds the remaining uncompensated late minutes');
    }
    if (record.creditMode === 'MERGE' && record.countTowardsMissingHours === true) {
      const shortage = Math.max(0, Number(target.requiredMinutes || 0) - Number(target.effectiveWorkedMinutes || 0));
      if (record.minutes > shortage) throw new Error(`Late hour credit exceeds the remaining missing hours (${shortage} minutes)`);
    }
    // SEPARATE does not alter late penalties or attendance totals.
    return;
  }
  if (target.status === 'LEAVE' || target.status === 'OFF') {
    throw new Error('Cannot credit working hours on a leave/non-working day');
  }
  if (target.intervals?.some(i => i.open)) throw new Error('Close the attendance session before crediting hours');
  const shortage = Math.max(0, Number(target.requiredMinutes ?? 0) - Number(target.effectiveWorkedMinutes ?? 0));
  if (record.creditMode !== 'SEPARATE' && record.minutes > shortage) throw new Error(`Credit exceeds remaining required-hour shortage (${shortage} minutes)`);
  if (record.creditMode === 'SEPARATE') {
    // A separate-mode note does not credit hours, but still must be bounded.
    const existingSeparate = await Compensation.aggregate([
      { $match: { employeeId: record.employeeId, date: record.date, status: 'APPROVED', creditMode: 'SEPARATE' } },
      { $group: { _id: null, minutes: { $sum: '$minutes' } } }
    ]);
    const existing = Number(existingSeparate[0]?.minutes || 0);
    if (record.minutes + existing > Math.max(0, Number(target.requiredMinutes ?? 0))) {
      throw new Error('Separate adjustments exceed required daily hours');
    }
  }
  if (record.type === 'EXTRA_HOURS_TRANSFER') {
    const source = await day(record.employeeId, record.sourceDate);
    if (!source || source.status !== 'PRESENT' || source.intervals?.some(i => i.open)) {
      throw new Error('Source day must be a closed, worked attendance day');
    }
    if (source.requiresAttendanceReview || (source.sequenceAnomalies || []).length) {
      throw new Error('Source attendance includes unverified or inconsistent punches; resolve before transferring overtime');
    }
    if (record.minutes > Number(source.availableOvertimeMinutes || 0)) {
      throw new Error(`Transfer exceeds source available overtime (${source.availableOvertimeMinutes || 0} minutes)`);
    }
  }
}
// Run the hour budget debit/credit and approval status change in ONE MongoDB
// transaction. Atlas replica sets support transactions; standalone MongoDB
// should fail closed instead of risking double-paid overtime.
async function transitionCompensation(item, expectedStatus, action, req, now, reason) {
  const change = {
    $set: { status: action, decidedBy: req.user._id, decidedAt: now, decisionReason: reason },
    $push: { history: { action, actorId: req.user._id, actorEmail: req.user.email, at: now, reason } }
  };
  return mongoose.connection.transaction(async (session) => {
    if (item.type === 'EXTRA_HOURS_TRANSFER') {
      const source = await day(item.employeeId, item.sourceDate);
      if (action === 'APPROVED' && (!source || source.status !== 'PRESENT' ||
          source.intervals?.some(i => i.open) || source.requiresAttendanceReview ||
          (source.sequenceAnomalies || []).length)) {
        throw new Error('Overtime source has incomplete or ambiguous punches; attendance review required');
      }
      // Revocation must always remain possible even after source punches change.
      const earned = Math.max(0, Math.floor(Number(source?.overtimeMinutes || 0)));
      // Include already approved legacy transfers when the balance is first seeded.
      const historical = await Compensation.aggregate([
        { $match: { employeeId: item.employeeId, sourceDate: item.sourceDate,
          type: 'EXTRA_HOURS_TRANSFER', status: 'APPROVED' } },
        { $group: { _id: null, minutes: { $sum: '$minutes' } } }
      ]).session(session);
      const historicalUsed = Number(historical[0]?.minutes || 0);
      await OvertimeBalance.updateOne(
        { employeeId: item.employeeId, sourceDate: item.sourceDate },
        { $setOnInsert: { employeeId: item.employeeId, sourceDate: item.sourceDate,
          usedMinutes: historicalUsed, earnedMinutes: earned } },
        { upsert: true, session }
      );
      // Reconcile the available budget if a source day was corrected.
      await OvertimeBalance.updateOne(
        { employeeId: item.employeeId, sourceDate: item.sourceDate },
        { $set: { earnedMinutes: earned } }, { session }
      );
      const amount = action === 'APPROVED' ? Number(item.minutes) : -Number(item.minutes);
      const guard = action === 'APPROVED'
        ? { $expr: { $lte: [{ $add: ['$usedMinutes', amount] }, '$earnedMinutes'] } }
        : { usedMinutes: { $gte: -amount } };
      const budget = await OvertimeBalance.findOneAndUpdate(
        { employeeId: item.employeeId, sourceDate: item.sourceDate, ...guard },
        { $inc: { usedMinutes: amount } }, { new: true, session }
      );
      if (!budget) throw new Error('Source overtime balance is insufficient or changed; refresh and retry');
    }
    const updated = await Compensation.findOneAndUpdate(
      { _id: item._id, status: expectedStatus }, change,
      { new: true, runValidators: true, session }
    );
    if (!updated) throw new Error('Compensation was changed by another administrator; refresh');
    return updated;
  });
}

async function logDecision(req, action, record) {
  // Not dependent on the global optional auditLogging setting.
  try {
    await AuditLog.create({ actorId: String(req.user._id), actorEmail: req.user.email,
      actorRole: req.access.roleCode, action: `compensation.${action.toLowerCase()}`,
      method: req.method, path: req.originalUrl, ip: req.ip, targetId: String(record._id),
      metadata: { compensationId: String(record._id), employeeId: record.employeeId,
        date: record.date, sourceDate: record.sourceDate, type: record.type,
        minutes: record.minutes, status: record.status, creditMode: record.creditMode, origin: record.origin } });
  } catch (err) { console.error('Compensation audit mirror unavailable:', err.message); }
}
// Prevent a second pending or approved credit for the same employee, target
// date and credit category. Rejected/revoked records do not block eligibility.
// A unique PENDING index handles simultaneous submissions; the existing
// APPROVED indexes handle concurrent administrator approvals.
function creditConflictFilters(value) {
  const base = { employeeId: value.employeeId, date: value.date,
    status: { $in: ['PENDING', 'APPROVED'] } };
  const filters = [];
  if (value.lateBucket === 'LATE') filters.push({ ...base, lateBucket: 'LATE' });
  if (value.creditBucket === 'HOURS') filters.push({ ...base, creditBucket: 'HOURS' });
  if (value.separateBucket) {
    // Also catch older SEPARATE records created before separateBucket existed.
    filters.push({ ...base, type: value.type, creditMode: 'SEPARATE' });
  }
  return filters;
}
async function assertNoExistingCredit(value) {
  for (const filter of creditConflictFilters(value)) {
    const existing = await Compensation.findOne(filter).select('_id status').lean();
    if (existing) throw new Error(`A ${existing.status.toLowerCase()} compensation for this category already exists on this date. ` +
      (existing.status === 'APPROVED' ? 'Revoke it first.' : 'Decide or reject the pending request first.'));
  }
}
function isDuplicateKey(error) { return error?.code === 11000; }
async function create(req, res) {
  try {
    if (!can(req, 'attendance.compensation.request')) return failure(res, 403, 'Missing compensation request permission');
    const value = normalizeBody(req.body);
    if (!(await visible(req, value.employeeId))) return failure(res, 403, 'Employee outside your scope');
    if (!(await Employee.exists({ employeeId: value.employeeId }))) return failure(res, 404, 'Employee not found');
    await assertNoExistingCredit(value);
    const item = await Compensation.create({ ...value, origin: 'ADMIN', requestedBy: req.user._id,
      history: [{ action: 'REQUESTED', actorId: req.user._id, actorEmail: req.user.email, reason: value.reason }] });
    await logDecision(req, 'REQUESTED', item);
    return res.status(201).json({ success: true, compensation: item });
  } catch (e) { return failure(res, isDuplicateKey(e) ? 409 : /already exists/.test(e.message) ? 409 : 400,
    isDuplicateKey(e) ? 'A pending compensation already exists for this employee and date' : e.message); }
}
async function legacyLateRequest(req, res) {
  req.body = { employeeId: req.params.employeeId, date: req.params.date,
    type: 'LATE_ARRIVAL', minutes: req.body?.minutes, reason: req.body?.reason,
    creditMode: 'MERGE', legacyLateOnly: true };
  return create(req, res);
}
async function list(req, res) {
  try {
    if (!can(req, 'attendance.compensation.view')) return failure(res, 403, 'Missing compensation view permission');
    const ids = await getAllowedEmployeeIds(req);
    const filter = ids === null ? {} : { employeeId: { $in: ids } };
    if (req.query.employeeId) {
      if (!(await visible(req, String(req.query.employeeId)))) return failure(res, 403, 'Employee outside your scope');
      filter.employeeId = String(req.query.employeeId);
    }
    if (req.query.status) {
      if (!['PENDING','APPROVED','REJECTED','REVOKED'].includes(req.query.status)) return failure(res, 400, 'Invalid status');
      filter.status = req.query.status;
    }
    if (req.query.type) {
      if (!TYPES.has(req.query.type)) return failure(res, 400, 'Invalid type');
      filter.type = req.query.type;
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const page = Math.max(1, Math.min(10000, Number(req.query.page) || 1));
    const [data, total] = await Promise.all([
      Compensation.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Compensation.countDocuments(filter)
    ]);
    return res.json({ success: true, data, total, page, limit });
  } catch (e) { return failure(res, 500, 'Unable to list compensations'); }
}
async function getOne(req, res) {
  try {
    if (!can(req, 'attendance.compensation.view')) return failure(res, 403, 'Missing compensation view permission');
    if (!mongoose.isValidObjectId(req.params.id)) return failure(res, 400, 'Invalid compensation ID');
    const item = await Compensation.findById(req.params.id).lean();
    if (!item) return failure(res, 404, 'Compensation not found');
    if (!(await visible(req, item.employeeId))) return failure(res, 403, 'Employee outside your scope');
    return res.json({ success: true, compensation: item });
  } catch (e) { return failure(res, 500, 'Unable to load compensation'); }
}
async function decide(req, res, action) {
  try {
    if (!can(req, action === 'REVOKED' ? 'attendance.compensation.revoke' : 'attendance.compensation.approve')) return failure(res, 403, 'Missing compensation decision permission');
    if (!mongoose.isValidObjectId(req.params.id)) return failure(res, 400, 'Invalid compensation ID');
    const item = await Compensation.findById(req.params.id);
    if (!item) return failure(res, 404, 'Compensation not found');
    if (!(await visible(req, item.employeeId, true))) return failure(res, 403, 'Outside approval scope');
    const expectedStatus = action === 'REVOKED' ? 'APPROVED' : 'PENDING';
    if (item.status !== expectedStatus) return failure(res, 409, `Only ${expectedStatus} requests can be ${action.toLowerCase()}`);
    if (String(item.requestedBy) === String(req.user._id) && String(req.access.roleCode).toUpperCase() !== 'SUPER_ADMIN') return failure(res, 403, 'Maker-checker rule: another administrator must decide this request');
    const reason = String(req.body?.reason || '').trim();
    if ((action === 'REJECTED' || action === 'REVOKED') && (!reason || reason.length > MAX_REASON)) {
      return failure(res, 400, 'A decision reason of 1–1000 characters is required');
    }
    if (action === 'APPROVED') {
      for (const conflicting of creditConflictFilters(item)) {
        const otherApproved = await Compensation.exists({ ...conflicting,
          status: 'APPROVED', _id: { $ne: item._id } });
        if (otherApproved) return failure(res, 409,
          'An approved compensation already covers this category and date. Revoke it first.');
      }
      await validateCredit(item);
      if (item.type === 'EXTRA_HOURS_TRANSFER') {
        const source = await day(item.employeeId, item.sourceDate);
        const physicallyClosed = Math.max(0, Number(source?.verifiedOvertimeMinutes || 0));
        // Auto-generated OUT is only a scheduled cutoff, not proof of attendance.
        // The manager must explicitly attest before crediting time that may
        // have been created by an automatic checkout.
        if (item.minutes > physicallyClosed && req.body?.confirmAutoCheckout !== true) {
          return failure(res, 409,
            'Overtime includes auto-checkout minutes. Review the source punches and approve again with confirmAutoCheckout: true');
        }
      }
    }
    const now = new Date();
    const updated = item.type === 'EXTRA_HOURS_TRANSFER' && ['APPROVED', 'REVOKED'].includes(action)
      ? await transitionCompensation(item, expectedStatus, action, req, now, reason)
      : await Compensation.findOneAndUpdate({ _id: item._id, status: expectedStatus }, {
          $set: { status: action, decidedBy: req.user._id, decidedAt: now, decisionReason: reason },
          $push: { history: { action, actorId: req.user._id, actorEmail: req.user.email, at: now, reason } }
        }, { new: true, runValidators: true });
    if (!updated) return failure(res, 409, 'Request was modified by another administrator; refresh');
    await logDecision(req, action, updated);
    return res.json({ success: true, compensation: updated });
  } catch (e) {
    if (e.code === 11000) return failure(res, 409, 'Another approved hour credit already exists for the target date');
    return failure(res, 400, e.message || 'Compensation decision failed');
  }
}
// Employee self-service is always scoped to the authenticated employee; never accept employeeId from the browser.
async function myRequests(req, res) {
  try {
    const employeeId = String(req.user?.employeeId || '').trim();
    if (!employeeId) return failure(res, 403, 'Employee profile is not linked');
    const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
    const limit = 30;
    const [data, total] = await Promise.all([
      Compensation.find({ employeeId }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Compensation.countDocuments({ employeeId })
    ]);
    // Do not disclose admin emails and internal actor identifiers in employee response.
    return res.json({ success: true, data: data.map(({ history, requestedBy, decidedBy, ...item }) => ({
      ...item, history: (history || []).map(({ action, at, reason }) => ({ action, at, reason }))
    })), total, page, limit });
  } catch (e) { return failure(res, 500, 'Unable to list your requests'); }
}
async function employeeRequest(req, res) {
  try {
    const employeeId = String(req.user?.employeeId || '').trim();
    if (!employeeId) return failure(res, 403, 'Employee profile is not linked');
    // Employees do not choose the admin-only hours-credit policy. Employee
    // late requests continue as late-only allowances until admin selects
    // an explicit hours-credit request on the admin side.
    const value = normalizeBody({ ...req.body, employeeId,
      legacyLateOnly: String(req.body?.type || '').toUpperCase() === 'LATE_ARRIVAL' });
    if (value.creditMode !== 'MERGE') return failure(res, 403, 'Only administrators can create separate-mode adjustments');
    if (!(await Employee.exists({ employeeId }))) return failure(res, 404, 'Employee not found');
    if (value.date >= today()) return failure(res, 400, 'Select a completed past attendance day');
    if (value.type === 'EXTRA_HOURS_TRANSFER' && value.sourceDate >= today()) return failure(res, 400, 'Overtime source must be a completed past day');
    // Eligibility is revalidated at approval; no hours are credited on submission.
    await assertNoExistingCredit(value);
    const item = await Compensation.create({ ...value, origin: 'EMPLOYEE', requestedBy: req.user._id,
      history: [{ action: 'REQUESTED', actorId: req.user._id, actorEmail: req.user.email || '', reason: value.reason }] });
    await logDecision(req, 'REQUESTED', item);
    return res.status(201).json({ success: true, compensation: { id: item._id, employeeId, date: item.date,
      sourceDate: item.sourceDate, type: item.type, creditMode: item.creditMode, minutes: item.minutes, status: item.status } });
  } catch (e) { return failure(res, isDuplicateKey(e) ? 409 : /already exists/.test(e.message) ? 409 : 400,
    isDuplicateKey(e) ? 'A pending compensation already exists for this employee and date' : e.message); }
}
module.exports = {
  create, legacyLateRequest, list, getOne, myRequests, employeeRequest,
  approve: (req,res) => decide(req,res,'APPROVED'),
  reject: (req,res) => decide(req,res,'REJECTED'),
  revoke: (req,res) => decide(req,res,'REVOKED')
};
