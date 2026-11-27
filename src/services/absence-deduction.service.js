const deductionModel=()=>require('../models/AbsenceDeduction');
const {labelKey,labelDate,addDay,employeeLabel}=require('../utils/employee-time');
function coveredDays(leave,day){
 if(!['APPROVED','PENDING'].includes(leave.status)||(leave.status==='PENDING'&&leave.deductBalance===false))return 0;
 if(leave.policySnapshot?.chargeableDates){if(!leave.policySnapshot.chargeableDates.includes(day))return 0;}
 else if(day<labelKey(leave.fromDate||leave.date)||day>labelKey(leave.toDate||leave.date))return 0;
 return leave.leaveMinutes ? Math.min(1,Number(leave.days)||0) : leave.halfDay ? .5 : 1;
}
function uncovered(row,leaves){
 if(row.status!=='ABSENT'||row.scheduledWorkingDay!==true||row.holiday||row.requiredMinutes<=0||row.requiresAttendanceReview||row.punches?.length)return 0;
 return Math.max(0,1-leaves.reduce((s,l)=>s+coveredDays(l,row.attendanceDate),0));
}
async function deductions(employeeId,year,leaves=[]){
 const rows=await deductionModel().find({employeeId:String(employeeId),day:{$gte:`${year}-01-01`,$lte:`${year}-12-31`},active:true}).lean();
 return rows.map(r=>({...r,days:Math.max(0,Math.min(r.days,1-leaves.reduce((s,l)=>s+coveredDays(l,r.day),0)))})).filter(r=>r.days>0);
}
let running=false;
async function reconcile({apply=false,now=new Date()}={}){
 if(running)throw Error('Absence reconciliation already running');
 running=true;
 try{
 const start=process.env.ABSENCE_DEDUCTION_START_DATE||'';
 if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||labelKey(labelDate(start))!==start)throw Error('Set ABSENCE_DEDUCTION_START_DATE to a valid date');
 const {Employee,Leave,LeaveType}=require('../models');
 const type=await LeaveType.findOne({code:String(process.env.ABSENCE_DEDUCTION_LEAVE_CODE||'SL').toUpperCase(),active:true}).lean();
 if(!type)throw Error('Configured absence leave category does not exist or is inactive');
 const employees=await Employee.find({active:true}).lean();
 const changes=[];
 for(const emp of employees){
   // Two completed local calendar days allow overnight shifts and delayed device imports.
   const last=addDay(labelKey(employeeLabel(now,emp)),-2);
   const joined=labelKey(employeeLabel(emp.dateOfJoining||emp.createdAt||now,emp));
   const first=start>joined?start:joined;
   if(first>last)continue;
   const rows=await require('./report.service').buildReport({from:first,to:last,employeeId:emp.employeeId});
   const leaves=await Leave.find({employeeId:emp.employeeId,status:{$in:['APPROVED','PENDING']}}).lean();
   const old=await deductionModel().find({employeeId:emp.employeeId,day:{$gte:first,$lte:last}}).lean();
   const byDay=new Map(old.map(r=>[r.day,r]));
   for(const row of rows){
     const day=row.attendanceDate, prev=byDay.get(day);
     // Existing full/half leave continues to use its original quota. Only entirely absent days are auto-charged.
     const days=uncovered(row,leaves);
     if(!prev&&!days)continue;
     if(prev&&prev.days===days&&prev.active===(days>0))continue;
     const entry={at:now,days,active:days>0,reason:days?'Finalized absence':'Attendance or leave reconciled'};
     changes.push({employeeId:emp.employeeId,day,days,previous:prev?.days||0});
     if(apply)await deductionModel().updateOne({_id:`${emp.employeeId}|${day}`},{$set:{days,active:days>0},$setOnInsert:{employeeId:emp.employeeId,day,leaveTypeId:type._id},$push:{history:entry}},{upsert:true,runValidators:true});
   }
 }
 return changes;
 }finally{running=false;}
}
module.exports={coveredDays,uncovered,deductions,reconcile};
