const mongoose=require('mongoose');
module.exports=mongoose.model('LeavePolicyProfile',new mongoose.Schema({name:{type:String,required:true,trim:true,maxlength:100,unique:true},rules:{type:mongoose.Schema.Types.Mixed,required:true}},{timestamps:true}));
