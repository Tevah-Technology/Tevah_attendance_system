const {validate,resolve}=require('./employee-exception.service');
function validateSchedule(body){
 const raw=body.weekdayMinutes??{};
 if(typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid weekday minutes');
 const weekdayMinutes={};
 for(const [k,v] of Object.entries(raw)) {if(!/^[1-7]$/.test(k)||!Number.isInteger(v)||v<0||v>1440)throw Error('Weekday minutes must be integers 0–1440');weekdayMinutes[k]=v;}
 const rows=body.scheduleExceptions??[];
 if(!Array.isArray(rows)||rows.length>100)throw Error('Maximum 100 shift exceptions');
 const scheduleExceptions=rows.map((r,i)=>{if(!r||!['hours','holiday'].includes(r.category))throw Error('Only hours and holiday shift exceptions are supported');return {...validate(r),_id:`shift-exception-${i}`,active:true};});
 return {weekdayMinutes,scheduleExceptions};
}
function resolveShiftSchedule(shift,rows,key,base,holiday){
 const weekday=String(new Date(key+'T00:00:00Z').getUTCDay()||7);
 const configured=shift?.weekdayMinutes instanceof Map?shift.weekdayMinutes.get(weekday):shift?.weekdayMinutes?.[weekday];
 const selected=(!Array.isArray(shift?.workingDays)||shift.workingDays.includes(Number(weekday)))&&Number.isInteger(configured);
 const minutes=selected?configured:base;
 const combined=[...(shift?.scheduleExceptions||[]).map((r,i)=>({...r,scopePriority:0,_id:`shift-${String(i).padStart(4,'0')}`})),...rows.map(r=>({...r,scopePriority:1,revisions:(r.revisions||[]).map(v=>({...v,scopePriority:1}))}))];
 const result=resolve(combined,key,minutes,holiday);
 if(selected){if(!result.applied.length)result.applied.push({category:'hours',mode:'override',reason:'Shift weekday hours'});if(result.working===null&&!result.holiday)result.working=minutes>0;}
 return result;
}
module.exports={validateSchedule,resolveShiftSchedule};
