const { LateArrivalReason, AuditLog } = require('../models');
const { buildReport } = require('../services/report.service');
const { getAllowedEmployeeIds, assertEmployeeAllowed } = require('../services/access-scope.service');

const dateKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const fail = (res, status, message) => res.status(status).json({ success: false, message });
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00`);
  return !Number.isNaN(d.getTime()) && dateKey(d) === value && value <= dateKey(new Date());
}
async function audit(req, action, record) {
  try { await AuditLog.create({ actorId: String(req.user._id), actorEmail: req.user.email || '', actorRole: req.access.roleCode,
    action, method: req.method, path: req.originalUrl, ip: req.ip, targetId: String(record._id),
    metadata: { employeeId: record.employeeId, date: record.date, reasonId: String(record._id) } });
  } catch (e) { console.error('Late arrival audit mirror failed:', e.message); }
}
async function dayRow(employeeId, date) {
  const rows = await buildReport({ employeeId, from: date, to: date });
  return rows.find(r => dateKey(new Date(r.date)) === date) || rows[0] || null;
}
async function pending(req, res) {
  try {
    const employeeId = req.user.employeeId;
    if (!employeeId) return fail(res, 403, 'Employee account required');
    const end = new Date(); const from = new Date(); from.setDate(from.getDate() - 6);
    const rows = await buildReport({ employeeId, from, to: end });
    const dates = rows.filter(r => r.firstIn && Number(r.rawLateMinutes) > 0 && validDay(dateKey(new Date(r.date))))
      .map(r => ({ ...r, date: dateKey(new Date(r.date)) }))
      .sort((a,b) => b.date.localeCompare(a.date));
    const submitted = await LateArrivalReason.find({ employeeId, date: { $in: dates.map(r=>r.date) } }).select('date').lean();
    const existing = new Set(submitted.map(r=>r.date));
    const candidate = dates.find(r => !existing.has(r.date));
    return res.json({ success: true, pending: candidate ? {
      date: candidate.date, firstIn: candidate.firstIn, lateMinutes: candidate.rawLateMinutes,
      shiftStart: candidate.shift?.startTime || candidate.lateCutoffTime || null
    } : null });
  } catch (e) { return fail(res, 500, e.message); }
}
async function submit(req, res) {
  try {
    const employeeId = req.user.employeeId;
    if (!employeeId) return fail(res, 403, 'Employee account required');
    const date = String(req.body?.date || '');
    const reason = String(req.body?.reason || '').trim();
    if (!validDay(date)) return fail(res, 400, 'Invalid attendance date');
    if (reason.length < 5 || reason.length > 1000) return fail(res, 400, 'Reason must contain 5–1000 characters');
    const row = await dayRow(employeeId, date);
    if (!row?.firstIn || Number(row.rawLateMinutes) <= 0) return fail(res, 400, 'No late IN punch exists for this day');
    const record = await LateArrivalReason.create({ employeeId, date, firstIn: row.firstIn,
      lateMinutesAtSubmission: Math.max(1, Math.ceil(Number(row.rawLateMinutes))), reason,
      submittedBy: req.user._id, history: [{ action: 'SUBMITTED', actorId: req.user._id, note: reason }] });
    await audit(req, 'late_reason.submitted', record);
    return res.status(201).json({ success: true, reason: record });
  } catch (e) {
    if (e.code === 11000) return fail(res, 409, 'Explanation already submitted for this date');
    return fail(res, 500, e.message);
  }
}
async function list(req, res) {
  try {
    const ids = await getAllowedEmployeeIds(req);
    const query = ids === null ? {} : { employeeId: { $in: ids } };
    if (req.query.date) { if (!validDay(req.query.date)) return fail(res, 400, 'Invalid date'); query.date = req.query.date; }
    if (req.query.status) {
      if (!['SUBMITTED','REVIEWED'].includes(req.query.status)) return fail(res,400,'Invalid status');
      query.status = req.query.status;
    }
    const data = await LateArrivalReason.find(query).sort({ date: -1, createdAt: -1 }).limit(500).lean();
    return res.json({ success: true, data });
  } catch (e) { return fail(res, 500, e.message); }
}
async function review(req, res) {
  try {
    const note = String(req.body?.note || '').trim();
    if (note.length > 1000) return fail(res, 400, 'Review note is too long');
    const item = await LateArrivalReason.findById(req.params.id);
    if (!item) return fail(res, 404, 'Explanation not found');
    if (!await assertEmployeeAllowed(req, item.employeeId)) return fail(res, 403, 'Employee outside your scope');
    if (item.status !== 'SUBMITTED') return fail(res, 409, 'Explanation has already been reviewed');
    if (String(item.submittedBy) === String(req.user._id)) return fail(res, 403, 'You cannot review your own explanation');
    const updated = await LateArrivalReason.findOneAndUpdate({ _id: item._id, status: 'SUBMITTED' }, {
      $set: { status: 'REVIEWED', reviewedBy: req.user._id, reviewedAt: new Date(), reviewNote: note },
      $push: { history: { action: 'REVIEWED', actorId: req.user._id, note } }
    }, { new: true, runValidators: true });
    if (!updated) return fail(res, 409, 'Already reviewed');
    await audit(req, 'late_reason.reviewed', updated);
    return res.json({ success: true, reason: updated });
  } catch (e) { return fail(res, 400, e.message); }
}
module.exports = { pending, submit, list, review };
