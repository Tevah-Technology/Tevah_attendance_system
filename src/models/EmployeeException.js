const mongoose = require('mongoose');
const schema = new mongoose.Schema({
 employeeId:{type:String,required:true,index:true}, category:{type:String,enum:['hours','holiday','rules'],required:true},
 schedule:{type:String,enum:['single','multiple','range','recurring'],required:true},
 dates:[String], startDate:String,endDate:String, weekdays:[Number],
 mode:{type:String,required:true}, minutes:Number, ruleOverrides:{type:mongoose.Schema.Types.Mixed,default:null}, reason:{type:String,required:true},
 active:{type:Boolean,default:true}, endedAt:Date, validFrom:String, revisions:{type:[mongoose.Schema.Types.Mixed],default:[]}
},{timestamps:true,optimisticConcurrency:true});
schema.index({employeeId:1,active:1});
module.exports=mongoose.model('EmployeeException',schema);
