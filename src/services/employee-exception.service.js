'use strict';
const {labelKey}=require('../utils/employee-time');
const priority={single:3,multiple:3,range:2,recurring:1};
function validDate(k){return typeof k==='string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(Date.parse(k+'T00:00:00Z')) && new Date(k+'T00:00:00Z').toISOString().slice(0,10)===k;}
function validate(body){
 const {category,schedule,mode}=body; const reason=typeof body.reason==='string'?body.reason.trim():'';
 if(!reason||reason.length>1000)throw Error('A reason of 1–1000 characters is required');
 if(!Object.hasOwn(priority,schedule))throw Error('Invalid schedule');
 if(!['hours','holiday','rules'].includes(category))throw Error('Invalid category');
 if(!(category==='hours'?['override','add','reduce','exempt']:category==='holiday'?['holiday','working','off']:['override']).includes(mode))throw Error('Invalid mode');
 const out={category,schedule,mode,reason,dates:[],weekdays:[],startDate:null,endDate:null,minutes:null,ruleOverrides:null};
 if(category==='rules'){out.ruleOverrides=require('./employee-rule.service').validateOverrides(body.ruleOverrides);if(!Object.keys(out.ruleOverrides).length)throw Error('Choose at least one attendance rule');}
 if(category==='hours'&&mode!=='exempt'||category==='holiday'&&mode==='working'){
  if(!Number.isInteger(body.minutes)||body.minutes<0||body.minutes>1440)throw Error('Minutes must be an integer from 0 to 1440'); out.minutes=body.minutes;
 }
 if(schedule==='single'||schedule==='multiple'){
  const dates=schedule==='single'?[body.startDate || body.dates?.[0]]:body.dates;
  if(!Array.isArray(dates)||!dates.length||dates.length>366||!dates.every(validDate))throw Error('Invalid selected dates');out.dates=[...new Set(dates)].sort();
 }else{
  if(body.startDate!=null&&!validDate(body.startDate)||body.endDate!=null&&!validDate(body.endDate))throw Error('Invalid date bounds');
  out.startDate=body.startDate||null;out.endDate=body.endDate||null;
  if(schedule==='range'&&(!out.startDate||!out.endDate))throw Error('Both dates are required');
  if(schedule==='recurring'){
   if(!Array.isArray(body.weekdays)||!body.weekdays.length||!body.weekdays.every(d=>Number.isInteger(d)&&d>=1&&d<=7))throw Error('Choose weekdays 1–7');out.weekdays=[...new Set(body.weekdays)];
   if(!out.startDate)throw Error('Recurring exceptions require an effective start date');
  }
  if(out.startDate&&out.endDate&&out.endDate<out.startDate)throw Error('End date precedes start date');
 }
 return out;
}
function matches(e,key){if(e.active===false)return false;if(e.schedule==='single'||e.schedule==='multiple')return e.dates.includes(key);if(e.startDate&&key<e.startDate||e.endDate&&key>e.endDate)return false;return e.schedule==='range'||e.schedule==='recurring'&&e.weekdays.includes(new Date(key+'T00:00:00Z').getUTCDay()||7);}
function versionForDay(row,key){
 if(!row.validFrom||key>=row.validFrom)return row;
 return [...(row.revisions||[])].reverse().find(v=>(!v.validFrom||key>=v.validFrom)&&key<v.validUntil)||null;
}
function archiveVersion(row,effectiveDate){
 if(!validDate(effectiveDate)||row.validFrom&&effectiveDate<row.validFrom)throw Error('Invalid revision effective date');
 const revisions=[...(row.revisions||[])];
 if(!row.validFrom||row.validFrom<effectiveDate){
  const {revisions:ignored,...previous}=row;
  revisions.push({...previous,validUntil:effectiveDate});
 }
 return {validFrom:effectiveDate,revisions};
}
function ranked(rows,key){return rows.map(e=>versionForDay(e,key)).filter(e=>e&&matches(e,key)).sort((a,b)=>(b.scopePriority||0)-(a.scopePriority||0)||priority[b.schedule]-priority[a.schedule]||(new Date(b.updatedAt||0)-new Date(a.updatedAt||0))||String(b._id).localeCompare(String(a._id)));}
function resolveRules(rows,key,base){
 const applicable=ranked(rows,key).filter(e=>e.category==='rules');
 const overrides={};
 for(const row of [...applicable].reverse())Object.assign(overrides,require('./employee-rule.service').validateOverrides(row.ruleOverrides||{}));
 return {...base,...overrides,hasDateRuleOverride:applicable.length>0,hasDateOvertimeOverride:Object.hasOwn(overrides,'overtimeEnabled')};
}
function resolve(rows,key,base,holiday=null){
 const candidates=ranked(rows,key);
 const h=candidates.find(e=>e.category==='holiday'), x=candidates.find(e=>e.category==='hours');
 let minutes=base, working=null;
 if(h){if(h.mode==='working'){holiday=null;working=true;minutes=h.minutes;}else{working=false;minutes=0;holiday=h.mode==='holiday'?{_id:h._id,name:h.reason,type:'EMPLOYEE_EXCEPTION'}:null;}}
 const applyHours=Boolean(x&&working!==false&&!holiday);
 if(applyHours){minutes=x.mode==='exempt'?0:x.mode==='override'?x.minutes:x.mode==='add'?minutes+x.minutes:minutes-x.minutes;minutes=Math.max(0,Math.min(1440,minutes));if(minutes===0)working=false;else working=true;}
 return {minutes,working,holiday,applied:[h,applyHours?x:null].filter(Boolean),hoursException:x||null,holidayException:h||null};
}
async function listForEmployee(employeeId){return require('../models/EmployeeException').find({employeeId:String(employeeId)}).lean();}
function bulkEmployeeIds(input){
 if(!Array.isArray(input)||!input.length||input.length>100)throw Error('Select 1–100 employees');
 if(input.some(id=>typeof id!=='string'||!id.trim()||id.trim().length>128))throw Error('Invalid employee ID');
 return [...new Set(input.map(id=>id.trim()))];
}
module.exports={validate,matches,resolve,resolveRules,versionForDay,archiveVersion,listForEmployee,labelKey,bulkEmployeeIds};
