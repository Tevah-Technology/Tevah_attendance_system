const { LeaveRule } = require('../models');

const DEFAULTS = {
  key: 'global',
  maxLeaveDaysPerMonth: 0,
  maxLeaveDaysPerYear: 0,
  minimumAdvanceNoticeDays: 0,
  probationRestrictionEnabled: false,
  probationPeriodDays: 90,
  allowLeaveDuringProbation: true,
  includeWeekendsInLeaveDays: false,
  includeHolidaysInLeaveDays: false,
  carryForwardEnabled: true,
  carryForwardLimitDays: 0,
  approvalRequired: true,
  negativeBalanceAllowed: false,
  maxNegativeBalanceDays: 0,
  documentRequiredForSickLeave: false,
  documentRequiredAfterDays: 2,
  sickLeaveCodes: ['SL', 'SICK'],
  allowBackdatedLeave: false,
  maxBackdatedDays: 0,
  blockOverlappingRequests: true,
  maxConsecutiveLeaveDays: 0,
  minimumGapBetweenLeaveDays: 0,
  allowLeaveDuringNoticePeriod: true
};

async function getLeaveRule({ lean = true } = {}) {
  let rule = await LeaveRule.findOne({ key: 'global' });
  if (!rule) rule = await LeaveRule.create(DEFAULTS);
  return lean ? rule.toObject() : rule;
}

function effectiveLeavePolicy(rule, leaveType = null) {
  const type = leaveType || {};
  const pick = (field, globalField = field) =>
    type[field] !== undefined && type[field] !== null ? type[field] : rule[globalField];

  return {
    maxLeaveDaysPerMonth: pick('maxDaysPerMonth', 'maxLeaveDaysPerMonth'),
    maxLeaveDaysPerYear: Number(rule.maxLeaveDaysPerYear || 0),
    minimumAdvanceNoticeDays: pick('minimumAdvanceNoticeDays'),
    includeWeekendsInLeaveDays: pick('includeWeekendsInLeaveDays'),
    includeHolidaysInLeaveDays: pick('includeHolidaysInLeaveDays'),
    carryForwardEnabled: Boolean(rule.carryForwardEnabled && type.carryForward !== false),
    carryForwardLimitDays: pick('carryForwardLimitDays'),
    approvalRequired: pick('approvalRequired'),
    negativeBalanceAllowed: pick('negativeBalanceAllowed'),
    maxNegativeBalanceDays: pick('maxNegativeBalanceDays'),
    documentRequired: pick('documentRequired'),
    documentRequiredAfterDays: pick('documentRequiredAfterDays'),
    maxConsecutiveDays: Number(type.maxConsecutiveDays || rule.maxConsecutiveLeaveDays || 0)
  };
}

// Store full, validated profiles so later company default changes do not change a profile.
function validateProfileRules(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Rules must be an object');
  const output = {};
  for (const [k,v] of Object.entries(input)) {
    if (k === 'key' || !Object.hasOwn(DEFAULTS,k)) throw Error(`Unsupported rule: ${k}`);
    const sample = DEFAULTS[k];
    if (typeof sample === 'boolean' && typeof v !== 'boolean') throw Error(`${k} must be boolean`);
    if (typeof sample === 'number' && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10000)) throw Error(`Invalid ${k}`);
    if (Array.isArray(sample) && (!Array.isArray(v) || v.length > 100 || v.some(x=>typeof x!=='string'||!x.trim()||x.length>50))) throw Error(`Invalid ${k}`);
    output[k] = Array.isArray(sample) ? [...new Set(v.map(x=>x.trim().toUpperCase()))] : v;
  }
  return output;
}
async function employeeLeaveRule(employeeId, year, base) {
  base = base || await getLeaveRule();
  const assignment=await require('../models/EmployeeLeavePolicy').findOne({employeeId:String(employeeId),year:Number(year)}).lean();
  if (!assignment?.profileId) return base;
  const profile=await require('../models/LeavePolicyProfile').findById(assignment.profileId).lean();
  if (!profile) throw Error('Assigned leave policy profile not found');
  return {...base,...validateProfileRules(profile.rules),leavePolicyProfileId:String(profile._id)};
}
module.exports = { DEFAULTS, getLeaveRule, effectiveLeavePolicy, validateProfileRules, employeeLeaveRule };
