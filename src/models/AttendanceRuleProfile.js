const mongoose=require('mongoose');
module.exports=mongoose.model('AttendanceRuleProfile',new mongoose.Schema({name:{type:String,required:true,trim:true,unique:true,maxlength:100},rules:{type:mongoose.Schema.Types.Mixed,required:true,default:()=>({})}},{timestamps:true}));
