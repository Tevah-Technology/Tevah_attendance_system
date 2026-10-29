# Late Arrival Compensation - Backend Integration

Adds a role-protected late-arrival compensation feature while preserving the original F28 biometric timestamp.

## New permission
`attendance.compensate`

## New API
`POST /api/attendance/employee/:employeeId/day/:date/compensate-late`

Body:
```json
{
  "minutes": 10,
  "reason": "Approved traffic delay"
}
```

Use `minutes: 0` to clear compensation.

The route validates employee data scope and requires `attendance.compensate`.
The report engine calculates:

`effectiveLateMinutes = max(0, rawLateMinutes - lateCompensationMinutes)`

The original punch timestamp remains unchanged.
