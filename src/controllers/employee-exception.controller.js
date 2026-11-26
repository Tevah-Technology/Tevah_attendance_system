const Exception=require('../models/EmployeeException');
const {Employee}=require('../models');
const {validate,bulkEmployeeIds,archiveVersion}=require('../services/employee-exception.service');
const {assertEmployeeAllowed,restrictEmployeeFilter}=require('../services/access-scope.service');
const {audit}=require('../middleware/auth');
const {hasPermission}=require('../services/permission.service');
const canChangeRules=(req,category)=>category!=='rules'||hasPermission(req.access,'attendance.rules.override');
async function reschedule(category){if(category==='rules'){try{await require('../services/attendance.service').rescheduleOpenSessions();}catch(e){console.error('Rule exception saved but session rescheduling failed:',e.message);return 'Saved; rescheduling failed. Review active sessions.';}}return null;}
async function revisionFor(exception){const employee=await Employee.findOne({employeeId:exception.employeeId}).lean();if(!employee)throw Error('Employee not found');const {employeeLabel,labelKey}=require('../utils/employee-time');return archiveVersion(exception.toObject(),labelKey(employeeLabel(new Date(),employee)));}
const fail=(res,e)=>res.status(400).json({success:false,message:e.message});
async function list(req,res){try{const filter=await restrictEmployeeFilter(req,req.query.employeeId?{employeeId:String(req.query.employeeId)}:{});res.json({success:true,exceptions:await Exception.find(filter).sort({createdAt:-1}).lean()});}catch(e){fail(res,e);}}
async function create(req,res){try{const id=String(req.body.employeeId||'');if(!await assertEmployeeAllowed(req,id))return res.sendStatus(403);if(!await Employee.exists({employeeId:id}))return res.sendStatus(404);if(!canChangeRules(req,req.body.category))return res.sendStatus(403);const exception=await Exception.create({...validate(req.body),employeeId:id});const warning=await reschedule(exception.category);await audit(req,'employee.exception.create',{targetId:String(exception._id),employeeId:id});res.status(201).json({success:true,exception,warning});}catch(e){fail(res,e);}}
async function update(req,res){try{const exception=await Exception.findById(req.params.id);if(!exception)return res.sendStatus(404);if(!await assertEmployeeAllowed(req,exception.employeeId))return res.sendStatus(403);if(!exception.active)return res.status(409).json({success:false,message:'Inactive exception cannot be edited'});if(!canChangeRules(req,exception.category)||!canChangeRules(req,req.body.category))return res.sendStatus(403);const before=exception.toObject();Object.assign(exception,await revisionFor(exception),validate(req.body));await exception.save();const warning=await reschedule(before.category==='rules'?before.category:exception.category);await audit(req,'employee.exception.update',{targetId:String(exception._id),before,after:exception.toObject()});res.json({success:true,exception,warning});}catch(e){fail(res,e);}}
async function remove(req,res){try{const exception=await Exception.findById(req.params.id);if(!exception)return res.sendStatus(404);if(!await assertEmployeeAllowed(req,exception.employeeId))return res.sendStatus(403);if(!canChangeRules(req,exception.category))return res.sendStatus(403);if(!exception.active)return res.status(409).json({success:false,message:'Already inactive'});Object.assign(exception,await revisionFor(exception));exception.active=false;exception.endedAt=new Date();await exception.save();const warning=await reschedule(exception.category);await audit(req,'employee.exception.remove',{targetId:String(exception._id)});res.json({success:true,warning});}catch(e){fail(res,e);}}
async function bulkCreate(req,res){
 try{
  const ids=bulkEmployeeIds(req.body.employeeIds);
  const values=validate(req.body);
  if(!canChangeRules(req,values.category))return res.sendStatus(403);
  for(const id of ids){if(!await assertEmployeeAllowed(req,id))return res.sendStatus(403);}
  const employees=await Employee.find({employeeId:{$in:ids}}).select('employeeId').lean();
  const found=new Set(employees.map(e=>String(e.employeeId)));
  if(ids.some(id=>!found.has(id)))return res.status(404).json({success:false,message:'One or more employee IDs were not found'});
  // Validate all recipients before writing. Report individual outcomes if a write fails.
  const results=[];
  for(const id of ids){
   let exception;
   try{exception=await Exception.create({...values,employeeId:id});}
   catch(e){results.push({employeeId:id,success:false,message:'Exception could not be saved'});continue;}
   let auditWarning=false;
   try{await audit(req,'employee.exception.create',{targetId:String(exception._id),employeeId:id});}catch(e){auditWarning=true;}
   results.push({employeeId:id,success:true,exceptionId:String(exception._id),auditWarning});
  }
  const created=results.filter(r=>r.success).length;
  const warning=created?await reschedule(values.category):null;
  return res.status(200).json({success:created===ids.length,created,requested:ids.length,results,warning});
 }catch(e){fail(res,e);}
}
module.exports={list,create,update,remove,bulkCreate};
