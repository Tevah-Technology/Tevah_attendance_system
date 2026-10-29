# Date-specific Shift Assignments

This backend now supports employee shift assignments for a single date, a date range, or recurring weekdays.

Priority used by the attendance engine:
1. single-date assignment
2. date-range assignment
3. recurring assignment
4. employee default shift (`Employee.shiftId`)
5. company default shift (`Rule.defaultShiftId`)

## Shift fields

`Shift` now includes `attendanceUnits` (0 to 1). Examples:
- Full shift: `requiredMinutes: 480`, `attendanceUnits: 1`
- Half shift: `requiredMinutes: 240`, `attendanceUnits: 0.5`

Example evening half shift:

```json
{
  "name": "Evening Half Shift",
  "startTime": "16:15",
  "endTime": "20:15",
  "requiredMinutes": 240,
  "attendanceUnits": 0.5,
  "graceMinutes": 0,
  "workingDays": [1,2,3,4,5,6]
}
```

## Assignment API

### Create a single-date assignment
POST `/api/shift-assignments`

```json
{
  "employeeId": "EMP001",
  "shiftId": "SHIFT_MONGODB_OBJECT_ID",
  "assignmentType": "single_date",
  "date": "2026-10-18",
  "notes": "Approved evening assignment"
}
```

### Create a date-range assignment
POST `/api/shift-assignments`

```json
{
  "employeeId": "EMP001",
  "shiftId": "SHIFT_MONGODB_OBJECT_ID",
  "assignmentType": "date_range",
  "startDate": "2026-10-18",
  "endDate": "2026-10-25"
}
```

### Create a recurring assignment
POST `/api/shift-assignments`

```json
{
  "employeeId": "EMP001",
  "shiftId": "SHIFT_MONGODB_OBJECT_ID",
  "assignmentType": "recurring",
  "startDate": "2026-10-01",
  "endDate": "2026-12-31",
  "recurringDays": [1,3,5]
}
```

### Resolve the effective shift
GET `/api/shift-assignments/resolve?employeeId=EMP001&date=2026-10-18`

### List assignments
GET `/api/shift-assignments?employeeId=EMP001`

### Edit / delete
PUT `/api/shift-assignments/:id`
DELETE `/api/shift-assignments/:id`

## Attendance behavior

A date-specific shift uses its own start/end/required minutes/attendance units. Therefore an assigned `16:15-20:15` shift with 240 required minutes and 0.5 units produces a Half Day when the employee completes the shift.

Auto checkout also respects the date-specific shift end. It will not auto-close that employee at the normal 17:30 company boundary on the assigned date.
