const Allowance=require('../models/EmployeeLeaveAllowance');
function validateAllowance(body){
 const {year,annualAllocation}=body;
 if(!Number.isInteger(year)||year<1900||year>2200)throw Error('Invalid allowance year');
 if(typeof annualAllocation!=='number'||!Number.isFinite(annualAllocation)||annualAllocation<0||annualAllocation>366||!Number.isInteger(annualAllocation*2))throw Error('Allowance must be 0–366 days in half-day increments');
 const reason=typeof body.reason==='string'?body.reason.trim():'';
 if(!reason||reason.length>1000)throw Error('Reason required (1–1000 characters)');
 return {year,annualAllocation,reason};
}
async function annualAllocation(employeeId,leaveType,year){
 const row=await Allowance.findOne({employeeId:String(employeeId),leaveTypeId:leaveType._id,year:Number(year)}).lean();
 return Number(row?.annualAllocation ?? leaveType.annualAllocation ?? 0);
}
module.exports={validateAllowance,annualAllocation};
