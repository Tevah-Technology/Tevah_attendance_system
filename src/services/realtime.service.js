// Authorized, event-driven long polling. One MongoDB change stream per process.
// No periodic reads of attendance/leave data. A timeout is only a transport keepalive.
const mongoose = require('mongoose');
const { randomUUID, randomBytes, createCipheriv, createDecipheriv } = require('crypto');
const { EventEmitter } = require('events');
const models = require('../models');
const { hasPermission } = require('./permission.service');
const { getAllowedEmployeeIds } = require('./access-scope.service');
const bus = new EventEmitter();
bus.setMaxListeners(0);
const history = [];
const maxHistory = 2048;
let epoch = randomUUID(), sequence = 0, watcher = null, ready = false, retry = null;
const definitions = [
  ['attendance', models.Attendance], ['attendance', models.AttendanceAdjustment],
  ['attendance', models.Employee],
  ['attendance', models.LateArrivalReason], ['leave', models.Leave],
  ['leave', require('../models/AbsenceDeduction')],
  ['leave', require('../models/EmployeeLeaveAllowance')],
  ['compensation', models.Compensation], ['compensation', models.OvertimeBalance],
  ['notifications', models.EmployeeNotification],
  ['attendance', models.ShiftAssignment], ['attendance', models.EmployeeException],
];
const collections = new Map(definitions.map(([topic, model]) => [model.collection.name, topic]));
const known = new Map();
const cursorKey = randomBytes(32);
// Opaque, authenticated cursor bound to the account and requested scope.
function encodeCursor(identity) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cursorKey, iv);
  cipher.setAAD(Buffer.from(identity));
  const body = Buffer.concat([cipher.update(`${epoch}:${sequence}`,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');
}
function decodeCursor(value, identity) {
  try {
    if (!value || value.length > 512) return '';
    const bytes = Buffer.from(value,'base64url');
    if (bytes.length < 29) return '';
    const decipher = createDecipheriv('aes-256-gcm',cursorKey,bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(identity));
    decipher.setAuthTag(bytes.subarray(12,28));
    return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
  } catch (_) { return ''; }
}
function publish(topic, employeeId) {
  if (!employeeId) return;
  history.push({ seq: ++sequence, topic, employeeId: String(employeeId) });
  if (history.length > maxHistory) history.shift();
  bus.emit('change');
}
function reset() { epoch = randomUUID(); sequence = 0; history.length = 0; bus.emit('change'); }
function start() {
  if (watcher || retry) return;
  try {
    const stream = mongoose.connection.watch([
      { $match: { 'ns.coll': { $in: [...collections.keys()] }, operationType: { $in: ['insert','update','replace','delete'] } } },
    ], { fullDocument: 'updateLookup', maxAwaitTimeMS: 1000 });
    watcher = stream;
    // Mongo driver establishes the cursor lazily. A connection error causes a retry/reset.
    ready = true; reset();
    stream.on('change', change => {
      const key = `${change.ns.coll}:${change.documentKey?._id}`;
      const id = change.fullDocument?.employeeId || known.get(key);
      if (change.operationType === 'delete') known.delete(key);
      else if (id) {
        known.set(key, String(id));
        if (known.size > 20000) known.delete(known.keys().next().value);
      }
      publish(collections.get(change.ns.coll), id);
    });
    const failed = err => {
      if (watcher !== stream) return;
      watcher = null; ready = false; bus.emit('change');
      console.warn('[REALTIME] Change stream unavailable:', err?.message || 'closed');
      Promise.resolve(stream.close()).catch(() => {});
      retry = setTimeout(() => { retry = null; start(); }, 5000);
      retry.unref?.();
    };
    stream.on('error', failed);
    stream.on('close', failed);
    stream.on('end', failed);
  } catch (err) {
    ready = false;
    console.warn('[REALTIME] Start failed:', err.message);
    retry = setTimeout(() => { retry = null; start(); }, 5000);
    retry.unref?.();
  }
}
const permissionGroups = {
  attendance: ['dashboard.view','operations.view','reports.daily.view','attendance.view','attendance.live.view','attendance.history.view','attendance.compensation.view'],
  leave: ['dashboard.view','operations.view','reports.daily.view','attendance.view','attendance.live.view','attendance.history.view','leave.requests.view','leave.calendar.view','leave.balances.view','leave.view','attendance.compensation.view'],
  compensation: ['dashboard.view','operations.view','reports.daily.view','attendance.view','attendance.live.view','attendance.history.view','attendance.compensation.view'],
  notifications: [],
};
async function wait(req, res) {
  const self = req.query.scope === 'self';
  if (!self && req.query.scope !== 'management') return res.status(400).json({success:false,message:'Invalid realtime scope'});
  const own = String(req.user?.employeeId || '');
  const selfPermissions = { attendance:'self.attendance.view', leave:'self.leave.view', compensation:'self.attendance.view', notifications:'self.attendance.view' };
  const requested = new Set(String(req.query.topics || Object.keys(permissionGroups).join(',')).split(','));
  const topics = Object.keys(permissionGroups).filter(topic => requested.has(topic) && (self
    ? own && hasPermission(req.access, selfPermissions[topic])
    : permissionGroups[topic].some(p => hasPermission(req.access,p))));
  if (!topics.length) return res.status(403).json({success:false,message:'No realtime access'});
  const ids = self ? [own] : await getAllowedEmployeeIds(req);
  const allowed = ids === null ? null : new Set(ids.map(String));
  const cursor = String(req.query.cursor || '');
  const identity = `${req.user._id}:${req.query.scope}:${topics.join(',')}:${allowed === null ? '*' : [...allowed].sort().join(',')}`;
  const [clientEpoch, rawSeq] = decodeCursor(cursor,identity).split(':');
  const last = Number(rawSeq);
  res.set('Cache-Control','no-store');
  let timer, done = false;
  const cleanup = () => { clearTimeout(timer); bus.removeListener('change', check); res.removeListener('close', cleanup); done = true; };
  const send = (changed, resetFlag = false) => {
    if (done) return;
    cleanup();
    if (!res.destroyed) res.json({success:true,cursor:encodeCursor(identity),topics:changed,reset:resetFlag});
  };
  function check() {
    if (done) return;
    if (!ready) { cleanup(); if (!res.destroyed) res.status(503).json({success:false,message:'Realtime database stream unavailable'}); return; }
    if (clientEpoch !== epoch || !Number.isSafeInteger(last) || last < 0 || last > sequence || last < (history[0]?.seq ?? sequence + 1) - 1) return send(topics,true);
    const changed = [...new Set(history.filter(e => e.seq > last && topics.includes(e.topic) && (allowed === null || allowed.has(e.employeeId))).map(e => e.topic))];
    if (changed.length) send(changed);
  }
  res.on('close', cleanup);
  bus.on('change',check);
  timer = setTimeout(() => send([]),20000);
  check();
}
module.exports = { start, wait, publish };
