const mongoose = require('mongoose');
const schema = new mongoose.Schema({
 employeeId: {type:String,required:true,index:true},
 kind: {type:String,required:true}, title: {type:String,required:true},
 message: {type:String,required:true}, metadata: mongoose.Schema.Types.Mixed,
 readAt: {type:Date,default:null}
}, {timestamps:true});
schema.index({employeeId:1,createdAt:-1});
module.exports = mongoose.model('EmployeeNotification',schema);
