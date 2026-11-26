const mongoose = require('mongoose');
const schema = new mongoose.Schema({
 employeeId: {type:String,required:true},
 leaveTypeId: {type:mongoose.Schema.Types.ObjectId,ref:'LeaveType',required:true},
 year: {type:Number,required:true,min:1900,max:2200},
 annualAllocation: {type:Number,required:true,min:0,max:366},
 reason: {type:String,required:true,maxlength:1000}
},{timestamps:true});
schema.index({employeeId:1,leaveTypeId:1,year:1},{unique:true});
module.exports=mongoose.model('EmployeeLeaveAllowance',schema);
