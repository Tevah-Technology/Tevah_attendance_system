const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: String,
  employeeId: {type:String, required:true, index:true},
  day: {type:String, required:true},
  leaveTypeId: {type:mongoose.Schema.Types.ObjectId, required:true},
  days: {type:Number, required:true, min:0,max:1},
  active: {type:Boolean, default:true},
  history: [{at:Date, days:Number, active:Boolean, reason:String, _id:false}]
}, {timestamps:true});
schema.index({employeeId:1,day:1});
module.exports=mongoose.model('AbsenceDeduction',schema);
