const test = require('node:test');
const assert = require('node:assert/strict');
const { ownAccountPermissions } = require('../src/services/self-workspace-permissions');

test('linked managers and HR receive their own clock and leave access', () => {
  for (const role of ['MANAGER', 'HR', 'ADMIN', 'SUPER_ADMIN', 'EMPLOYEE']) {
    const rights = ownAccountPermissions({ role, active: true, employeeId: 'EMP007' });
    assert.ok(rights.includes('self.attendance.checkin'));
    assert.ok(rights.includes('self.attendance.checkout'));
    assert.ok(rights.includes('self.leave.view'));
    assert.ok(rights.every((p) => p.startsWith('self.')));
  }
});

test('unlinked and inactive logins receive no automatic self permissions', () => {
  assert.deepEqual(ownAccountPermissions({ role: 'ADMIN', active: true, employeeId: '' }), []);
  assert.deepEqual(ownAccountPermissions({ role: 'HR', active: false, employeeId: 'EMP007' }), []);
});
