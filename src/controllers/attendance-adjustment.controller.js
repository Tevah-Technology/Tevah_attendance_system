const {canSelectAttendanceDate,allowDates,localDay}=require('../utils/attendance-access');
const {AttendanceAdjustment,EmployeeNotification,Employee,AuditLog} = require('../models');
const {assertEmployeeAllowed} = require('../services/access-scope.service');
const {createNotice} = require('../services/attendance-adjustment-notify');
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s+'T12:00:00').getTime()) && new Date(s+'T12:00:00').toISOString().slice(0,10) === s;
const actor = req => String(req.user?._id || req.user?.id || req.user?.email || 'unknown');
async function list(req,res) {try {
 const employeeId=String(req.query.employeeId||'').trim(),date=String(req.query.date||'');
 if(!employeeId || !(await assertEmployeeAllowed(req,employeeId))) return res.status(403).json({success:false,message:'Employee outside data scope'});
 if(!canSelectAttendanceDate(req.access) && date && !allowDates(req,res,[date]))return;
 const query={employeeId}; if(!canSelectAttendanceDate(req.access))query.date=localDay(new Date()); if(date){if(!validDate(date)) return res.status(400).json({success:false,message:'Invalid date'});query.date=date;}
 return res.json({success:true,data:await AttendanceAdjustment.find(query).sort({createdAt:-1}).limit(200).lean()});
 }catch(e){return res.status(500).json({success:false,message:e.message});}}
async function create(req,res){try{
 const employeeId=String(req.body.employeeId||'').trim(),date=String(req.body.date||''),minutes=Number(req.body.minutes),reason=String(req.body.reason||'').trim();
 if(!employeeId || !validDate(date) || !Number.isInteger(minutes) || minutes<1 || minutes>1440 || reason.length<8) return res.status(400).json({success:false,message:'Valid employee, date, minutes (1-1440), and reason (at least 8 characters) are required'});
 if(!(await assertEmployeeAllowed(req,employeeId))) return res.status(403).json({success:false,message:'Employee outside data scope'});
 if(!allowDates(req,res,[date]))return;
 if(!(await Employee.exists({employeeId}))) return res.status(404).json({success:false,message:'Employee not found'});
 const item=await AttendanceAdjustment.create({employeeId,date,minutes,reason,actorId:actor(req),actorEmail:String(req.user?.email||'')});
 await AuditLog.create({actorId:actor(req),actorEmail:String(req.user?.email||''),action:'ATTENDANCE_HOURS_DEDUCTED',method:req.method,path:req.originalUrl,targetId:String(item._id),metadata:{employeeId,date,minutes,reason}});
 await createNotice(employeeId,'HOURS_DEDUCTION','Working hours adjusted',`${minutes} minute(s) were deducted for ${date}. Reason: ${reason}`,{adjustmentId:String(item._id),date,minutes});
 return res.status(201).json({success:true,data:item});
 }catch(e){return res.status(500).json({success:false,message:e.message});}}
async function revoke(req,res){try{
 const item=await AttendanceAdjustment.findById(req.params.id);
 if(!item)return res.status(404).json({success:false,message:'Adjustment not found'});
 if(!(await assertEmployeeAllowed(req,item.employeeId)))return res.status(403).json({success:false,message:'Employee outside data scope'});
 if(!allowDates(req,res,[item.date]))return;
 if(item.status!=='ACTIVE')return res.status(409).json({success:false,message:'Already revoked'});
 const reason=String(req.body.reason||'').trim();if(reason.length<8)return res.status(400).json({success:false,message:'Revocation reason required (8+ characters)'});
 item.status='REVOKED';item.revokedAt=new Date();item.revokedBy=actor(req);item.revokeReason=reason;await item.save();
 await AuditLog.create({actorId:actor(req),actorEmail:String(req.user?.email||''),action:'ATTENDANCE_DEDUCTION_REVOKED',method:req.method,path:req.originalUrl,targetId:String(item._id),metadata:{employeeId:item.employeeId,date:item.date,minutes:item.minutes,reason}});
 await createNotice(item.employeeId,'DEDUCTION_REVOKED','Hours deduction reversed',`The ${item.minutes}-minute deduction for ${item.date} was reversed. Reason: ${reason}`,{adjustmentId:String(item._id)});
 return res.json({success:true,data:item});
 }catch(e){return res.status(400).json({success:false,message:e.message});}}
async function mine(req,res){try{
 const employeeId=String(req.user?.employeeId||'').trim();if(!employeeId)return res.status(403).json({success:false,message:'Employee account not linked'});
 return res.json({success:true,data:await EmployeeNotification.find({employeeId}).sort({createdAt:-1}).limit(100).lean()});
 }catch(e){return res.status(500).json({success:false,message:e.message});}}
async function readMine(req,res){try{
 const employeeId=String(req.user?.employeeId||'').trim();if(!employeeId)return res.status(403).json({success:false,message:'Employee account not linked'});
 const doc=await EmployeeNotification.findOneAndUpdate({_id:req.params.id,employeeId},{$set:{readAt:new Date()}},{new:true});
 if(!doc)return res.status(404).json({success:false,message:'Notification not found'});
 return res.json({success:true,data:doc});
 }catch(e){return res.status(400).json({success:false,message:e.message});}}
module.exports={list,create,revoke,mine,readMine};
