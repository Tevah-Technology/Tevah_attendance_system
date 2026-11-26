const Profile=require('../models/HolidayCalendarProfile');
const {Employee}=require('../models');
const {calendarKey}=require('../services/holiday.service');
const {assertEmployeeAllowed,restrictEmployeeFilter}=require('../services/access-scope.service');
const {audit}=require('../middleware/auth');
const fail=(res,e)=>res.status(e.code===11000?409:400).json({success:false,message:e.message});
function validateCalendar(body){
 const {year,holidays}=body;
 if(!Number.isInteger(year)||year<1900||year>2200||!Array.isArray(holidays)||holidays.length>366)throw Error('Invalid calendar year or holiday list');
 const seen=new Set();
 return holidays.map(h=>{if(typeof h.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(h.date)||!h.date.startsWith(`${year}-`)||calendarKey(new Date(h.date+'T12:00:00'))!==h.date||seen.has(h.date))throw Error('Invalid or duplicate holiday date');seen.add(h.date);const name=typeof h.name==='string'?h.name.trim():'';if(!name||name.length>160)throw Error('Holiday name required');return {date:h.date,name};});
}
async function list(req,res){try{res.json({success:true,profiles:await Profile.find().sort({year:-1,name:1}).lean()});}catch(e){fail(res,e);}}
async function create(req,res){try{const profile=await Profile.create({name:req.body.name,year:req.body.year,holidays:validateCalendar(req.body)});await audit(req,'holiday.calendar.create',{targetId:String(profile._id)});res.status(201).json({success:true,profile});}catch(e){fail(res,e);}}
async function assignments(req,res){try{const filter=await restrictEmployeeFilter(req,req.query.employeeId?{employeeId:String(req.query.employeeId)}:{});const rows=await Employee.find(filter).select('employeeId holidayCalendarAssignments').lean();res.json({success:true,assignments:rows.flatMap(e=>(e.holidayCalendarAssignments||[]).map(a=>({...a,employeeId:e.employeeId})))});}catch(e){fail(res,e);}}
async function assign(req,res){try{
 const employeeId=String(req.body.employeeId||'');if(!await assertEmployeeAllowed(req,employeeId))return res.sendStatus(403);
 const {year,mode,profileId}=req.body;const reason=typeof req.body.reason==='string'?req.body.reason.trim():'';
 if(!Number.isInteger(year)||year<1900||year>2200||!['company','custom','both','none'].includes(mode)||!reason||reason.length>1000)throw Error('Valid year, mode and reason required');
 if(['custom','both'].includes(mode)&&!await Profile.exists({_id:profileId,year}))throw Error('Calendar profile must match the selected year');
 const employee=await Employee.findOne({employeeId});if(!employee)return res.sendStatus(404);
 const before=employee.holidayCalendarAssignments.map(a=>a.toObject());
 employee.holidayCalendarAssignments=[...before.filter(a=>a.year!==year),{year,mode,profileId:['custom','both'].includes(mode)?profileId:null,reason}];
 await employee.save();await audit(req,'holiday.calendar.assign',{targetId:employeeId,before,after:employee.holidayCalendarAssignments});
 res.json({success:true,assignments:employee.holidayCalendarAssignments});
}catch(e){fail(res,e);}}
module.exports={list,create,assignments,assign,validateCalendar};
