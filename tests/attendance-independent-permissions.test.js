const test = require('node:test');
const assert = require('node:assert/strict');
const { ALL_PERMISSIONS, rolePermissions, normalizePermissions } = require('../src/config/permissions');
const { INDEPENDENT_PERMISSIONS, localDay, isToday, allowDates, requireAttendanceDate, todayBounds } = require('../src/utils/attendance-access');
const fs = require('node:fs');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const now = new Date(2026, 10, 24, 12);
function response() { return { status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } }; }
test('catalog has three distinct keys and defaults preserve authorized capabilities for new roles', () => {
  assert.equal(ALL_PERMISSIONS.length, new Set(ALL_PERMISSIONS).size);
  for (const key of INDEPENDENT_PERMISSIONS) {
    assert.ok(ALL_PERMISSIONS.includes(key));
    assert.ok(rolePermissions.SUPER_ADMIN.includes(key));
    assert.ok(rolePermissions.ADMIN.includes(key));
    assert.deepEqual(normalizePermissions([key]), [key]);
  }
  assert.ok(rolePermissions.MANAGER.includes('attendance.date.select'));
  assert.ok(!rolePermissions.MANAGER.includes('attendance.deduct_hours'));
  assert.ok(!rolePermissions.EMPLOYEE.includes('attendance.date.select'));
});
test('date checks use local calendar and reject invalid/other dates', () => {
  assert.equal(localDay('2026-02-30'), null);
  assert.equal(isToday('2026-11-24', now), true);
  assert.equal(isToday('2026-11-23', now), false);
  const bounds = todayBounds(now);
  assert.equal(localDay(bounds.$gte), '2026-11-24');
  assert.equal(localDay(bounds.$lt), '2026-11-25');
});
test('date authorization is independent of edit and deduction permissions', () => {
  const req = { access: { permissions: ['attendance.edit', 'attendance.deduct_hours'] } };
  assert.equal(allowDates(req, response(), ['2026-11-24'], now), true);
  const res = response();
  assert.equal(allowDates(req, res, ['2026-11-23'], now), false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.permission, 'attendance.date.select');
  assert.equal(allowDates({ access: { permissions: ['attendance.date.select'] } }, response(), ['2026-11-23'], now), true);
  assert.equal(allowDates({ access: { roleCode: 'SUPER_ADMIN' } }, response(), ['2026-11-23'], now), true);
});
test('date middleware does not invoke protected handler for a denied request', () => {
  let called = 0;
  const guard = requireAttendanceDate(req => [req.query.date]);
  const res = response();
  guard({ access: { permissions: [] }, query: { date: '2000-01-01' } }, res, () => called++);
  assert.equal(called, 0);
  assert.equal(res.statusCode, 403);
  guard({ access: { permissions: ['attendance.date.select'] }, query: { date: '2000-01-01' } }, response(), () => called++);
  assert.equal(called, 1);
});
test('route wiring separates correction and deductions and guards daily data', () => {
  const routes = source('src/routes/index.js');
  assert.match(routes, /router\.put\('\/attendance\/:id', p\('attendance\.correct_punch'\), attendance\.update\)/);
  assert.match(routes, /router\.post\('\/attendance-adjustments', p\('attendance\.deduct_hours'\), attendanceAdjustment\.create\)/);
  assert.match(routes, /router\.post\('\/attendance-adjustments\/:id\/revoke', p\('attendance\.deduct_hours'\), attendanceAdjustment\.revoke\)/);
  assert.match(routes, /p\('reports\.daily\.view'\),\s*dateQuery,\s*report\.daily/);
  assert.match(routes, /p\('attendance\.employee\.view'\), dateParam, attendance\.employeeDay/);
  assert.match(source('src/services/role.service.js'), /definition\.permissions\.filter\(key => !INDEPENDENT_PERMISSIONS\.includes\(key\)\)/);
});
