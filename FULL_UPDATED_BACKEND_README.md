# Full Updated ZKTeco F28 Backend

This package is the complete backend from the supplied `zkteco-f28(4).zip` with the late-arrival compensation feature integrated.

## Included compensation feature

- New RBAC permission: `attendance.compensate`
- New protected endpoint:
  `POST /api/attendance/employee/:employeeId/day/:date/compensate-late`
- Stores compensation separately from the original biometric punch.
- Report calculations return raw late minutes, compensated minutes, and effective late minutes.
- Existing shift-assignment routes remain included.

## Setup

1. Copy `.env.example` to `.env`.
2. Restore your existing environment values, especially `MONGODB_URI`, `JWT_SECRET`, device settings, and CORS origins.
3. Run `npm install`.
4. Run `npm run dev`.

The package intentionally does not include `node_modules` or the private `.env` from the uploaded project.
