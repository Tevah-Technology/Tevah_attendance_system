// Calendar labels are separate from UTC instants. Existing report dates remain
// company-calendar labels, so compensation/leave keys are not silently changed.
const { startOfDay } = require('./time');
const formatters = new Map();
function validZone(zone) { try { if (typeof zone !== 'string' || !zone.trim()) return false; new Intl.DateTimeFormat('en', {timeZone:zone}); return true; } catch { return false; } }
function parts(value, zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}));
  return Object.fromEntries(formatters.get(zone).formatToParts(new Date(value)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
}
function localKey(value, zone) { const p=parts(value,zone); return `${p.year}-${p.month}-${p.day}`; }
function labelKey(value) { const d=new Date(value); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function labelDate(key) { const [y,m,d]=key.split('-').map(Number); return new Date(y,m-1,d); }
function addDay(key, n=1) { const d=new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function localInstant(key, hhmm, zone) {
  const target=Date.parse(`${key}T${hhmm}:00Z`);
  if (!Number.isFinite(target)) throw new Error('Invalid local date or time');
  const offsets=new Set();
  for(const h of [-36,-12,0,12,36]) {const t=target+h*3600000; const p=parts(t,zone); offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)-t);}
  const candidates=[...offsets].map(o=>target-o).sort((a,b)=>a-b);
  const exact=candidates.filter(t=>{const p=parts(t,zone);return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`===`${key}T${hhmm}`;});
  // Earlier occurrence for a repeated time; advance by the gap for nonexistent time.
  if(exact.length) return new Date(exact[0]);
  const later=candidates.filter(t=>{const p=parts(t,zone);return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`>`${key}T${hhmm}`;});
  if(!later.length) throw new Error('Cannot resolve local time');
  return new Date(later[0]);
}
function employeeLabel(value, employee) { return employee?.timezone ? labelDate(localKey(value,employee.timezone)) : startOfDay(value); }
function atLabel(date, time, employee, dayOffset=0) { if(employee?.timezone) return localInstant(addDay(labelKey(date),dayOffset),time,employee.timezone); const d=startOfDay(date); d.setDate(d.getDate()+dayOffset);const [h,m]=time.split(':').map(Number);d.setHours(h,m,0,0);return d; }
// Pair consecutive IN/OUT events before bucketing. Only hours-only shifts opt
// into start-date attribution. Duplicate INs stay with the original session.
function groupPunches(punches, employee, resolveShift) {
 const map=new Map(); let open=null;
 for(const p of [...punches].filter(p=>p?.timestamp).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp))) {
   const own=employeeLabel(p.timestamp,employee); let day=own;
   if(p.punchType==='IN' && !open) open={day:own, carry:resolveShift(own)?.shift?.shiftType==='WORKING_HOURS_ONLY'};
   if(open?.carry && ['IN','OUT'].includes(p.punchType)) day=open.day;
   if(p.punchType==='OUT') open=null;
   const k=day.toISOString(); if(!map.has(k))map.set(k,[]); map.get(k).push(p);
 }
 return map;
}
module.exports={validZone,localKey,labelKey,labelDate,addDay,localInstant,employeeLabel,atLabel,groupPunches};
