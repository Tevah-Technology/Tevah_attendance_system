# Leave Policy Rules + Holiday Calendar Backend Update

This backend now supports global leave policy rules, per-leave-type overrides, and a holiday calendar that participates in leave-day calculation.

## New API endpoints

### Leave policy
- `GET /api/leave-rules` — requires `rules.leavePolicy.view`
- `PUT /api/leave-rules` — requires `rules.leavePolicy.edit`

Supported global settings include:
- maximum leave days per month/year
- minimum advance notice
- probation restriction and probation duration
- weekend inclusion/exclusion
- holiday inclusion/exclusion
- carry-forward enable/limit
- approval required
- negative balance enable/limit
- sick-leave document requirement and threshold
- backdated leave rules
- overlap prevention
- maximum consecutive leave days
- minimum gap between leave periods
- notice-period restriction

### Holidays
- `GET /api/holidays` — requires `rules.holidays.view`
- `POST /api/holidays` — requires `rules.holidays.edit`
- `PUT /api/holidays/:id` — requires `rules.holidays.edit`
- `DELETE /api/holidays/:id` — requires `rules.holidays.edit`

Holiday fields:
- `name`
- `date`
- `type`: `PUBLIC`, `COMPANY`, or `OPTIONAL`
- `description`
- `recurringAnnual`
- `active`

## Leave type overrides

`LeaveType` now also supports optional overrides:
- `carryForwardLimitDays`
- `maxDaysPerMonth`
- `minimumAdvanceNoticeDays`
- `includeWeekendsInLeaveDays`
- `includeHolidaysInLeaveDays`
- `approvalRequired`
- `negativeBalanceAllowed`
- `maxNegativeBalanceDays`
- `documentRequired`
- `documentRequiredAfterDays`

Existing fields such as `annualAllocation`, `halfDayAllowed`, `carryForward`, and `maxConsecutiveDays` remain supported.

## Employee fields used by policy validation

The Employee model now supports optional:
- `dateOfJoining`
- `probationEndDate`
- `noticePeriodStartDate`

If `probationEndDate` is not supplied, the global probation duration is applied from `dateOfJoining` (or the employee record creation date as a fallback).

## Leave document fields

Leave requests now support:
- `documentRequired`
- `documentSubmitted`
- `documentUrl`
- `documentName`
- `policySnapshot`

When a document is required, approval is blocked until `documentSubmitted=true` or a non-empty `documentUrl` exists.

## Policy enforcement

On leave create/update, the backend now evaluates:
1. date validity and backdating
2. advance notice
3. probation restrictions
4. notice-period restrictions
5. weekend/holiday chargeable-day calculation
6. half-day eligibility
7. maximum consecutive days
8. overlapping leave requests
9. minimum gap between leave periods
10. monthly/yearly limits
11. leave-type balance and optional negative balance
12. sick-leave document requirement
13. approval-required policy

## Permissions

Added:
- `rules.leavePolicy.view`
- `rules.leavePolicy.edit`

Existing permissions used for holidays:
- `rules.holidays.view`
- `rules.holidays.edit`

SUPER_ADMIN and ADMIN receive new permissions automatically through the existing system-role synchronization. The HR Manager template also includes leave-policy and holiday management permissions.

## Install/check

```bash
npm install
npm run check
npm start
```

No manual MongoDB migration is required because the new fields are additive and optional. New singleton policy/holiday collections are created when used.
