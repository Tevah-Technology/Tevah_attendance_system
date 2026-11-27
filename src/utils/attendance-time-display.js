const { validZone, localKey } = require('./employee-time');
const IST = 'Asia/Kolkata';
const cache = new Map();
function effectiveZone(zone) { return validZone(zone) ? zone : (validZone(process.env.TZ) ? process.env.TZ : Intl.DateTimeFormat().resolvedOptions().timeZone || IST); }
function format(value, zone) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  if (!cache.has(zone)) cache.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, hour:'2-digit', minute:'2-digit', hour12:true }));
  return { time: cache.get(zone).format(date), date: localKey(date, zone), timezone: zone };
}
function fields(key, value, zone) {
  const local = format(value, zone), ist = format(value, IST);
  return { [`${key}Local`]:local?.time ?? null, [`${key}IST`]:ist?.time ?? null, [`${key}LocalDate`]:local?.date ?? null, [`${key}ISTDate`]:ist?.date ?? null };
}
function punchDisplay(punch, zone) { return punch ? { ...punch, displayTimezone: zone, ...fields('timestamp', punch.timestamp, zone) } : punch; }
function withAttendanceDisplay(row, assignedZone = row.timezone) {
  const zone = effectiveZone(assignedZone);
  const result = { ...row, displayTimezone:zone, istTimezone:IST };
  for (const key of ['firstIn','lastOut','firstPunch','lastPunch','timestamp','autoCheckoutAt','regularShiftEnd','overtimeAutoCheckoutAt']) if (Object.hasOwn(row,key)) Object.assign(result, fields(key,row[key],zone));
  if (Array.isArray(row.punches)) result.punches = row.punches.map(p => punchDisplay(p,zone));
  if (row.activePunch) result.activePunch = punchDisplay(row.activePunch,zone);
  if (Array.isArray(row.intervals)) result.intervals = row.intervals.map(i => ({...i,...fields('in',i.in,zone),...fields('out',i.out,zone)}));
  return result;
}
async function decoratePunches(rows, Employee) {
  const ids = [...new Set(rows.map(r=>String(r.employeeId || '')).filter(Boolean))];
  const employees = ids.length ? await Employee.find({employeeId:{$in:ids}}).select('employeeId timezone').lean() : [];
  const zones = new Map(employees.map(e=>[String(e.employeeId), e.timezone]));
  return rows.map(r=>punchDisplay(r,effectiveZone(zones.get(String(r.employeeId)))));
}
module.exports = {IST,effectiveZone,fields,punchDisplay,withAttendanceDisplay,decoratePunches};
