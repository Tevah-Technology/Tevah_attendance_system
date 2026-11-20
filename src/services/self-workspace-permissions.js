// Rights to the current authenticated account's *own* employee workspace.
// An employee linkage must be explicitly stored by an administrator.
// The /me endpoints always resolve employeeId from req.user, never from a
// caller-supplied query parameter. This does not authorize management access.
const SELF_WORKSPACE_PERMISSIONS = Object.freeze([
  'self.profile.view',
  'self.profile.edit',
  'self.attendance.view',
  'self.attendance.checkin',
  'self.attendance.checkout',
  'self.leave.view',
  'self.leave.create'
]);

function ownAccountPermissions(user) {
  if (!user || user.active === false || !String(user.employeeId || '').trim()) {
    return [];
  }
  return [...SELF_WORKSPACE_PERMISSIONS];
}

module.exports = { SELF_WORKSPACE_PERMISSIONS, ownAccountPermissions };
