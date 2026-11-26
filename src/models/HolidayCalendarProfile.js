const mongoose=require('mongoose');
const entry=new mongoose.Schema({date:{type:String,required:true},name:{type:String,required:true,maxlength:160}},{_id:false});
module.exports=mongoose.model('HolidayCalendarProfile',new mongoose.Schema({name:{type:String,required:true,unique:true,trim:true,maxlength:100},year:{type:Number,required:true},holidays:[entry]},{timestamps:true}));
