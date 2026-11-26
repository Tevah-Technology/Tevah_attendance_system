const mongoose=require('mongoose');
const schema=new mongoose.Schema({employeeId:{type:String,required:true},year:{type:Number,required:true},profileId:{type:mongoose.Schema.Types.ObjectId,ref:'LeavePolicyProfile',default:null},reason:{type:String,required:true,maxlength:1000}},{timestamps:true});
schema.index({employeeId:1,year:1},{unique:true});
module.exports=mongoose.model('EmployeeLeavePolicy',schema);
