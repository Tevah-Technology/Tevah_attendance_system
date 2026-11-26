const Profile=require('../models/LeavePolicyProfile');
const Assignment=require('../models/EmployeeLeavePolicy');
const {Employee}=require('../models');
const {validateProfileRules,getLeaveRule,DEFAULTS}=require('../services/leave-rule.service');
const {assertEmployeeAllowed,restrictEmployeeFilter}=require('../services/access-scope.service');
const {audit}=require('../middleware/auth');
const fail=(res,e)=>res.status(e.code===11000?409:400).json({success:false,message:e.message});
async function list(req,res){try{res.json({success:true,profiles:await Profile.find().sort({name:1}).lean()});}catch(e){fail(res,e);}}
async function create(req,res){try{
 const base=await getLeaveRule();
 const inherited=Object.fromEntries(Object.keys(DEFAULTS).filter(k=>k!=='key').map(k=>[k,base[k]??DEFAULTS[k]]));
 const profile=await Profile.create({name:req.body.name,rules:validateProfileRules({...inherited,...validateProfileRules(req.body.rules)})});
 await audit(req,'employee.leave.policy.create',{targetId:String(profile._id)});
 res.status(201).json({success:true,profile});
}catch(e){fail(res,e);}}
async function assignments(req,res){try{
 const filter=await restrictEmployeeFilter(req,req.query.employeeId?{employeeId:String(req.query.employeeId)}:{});
 res.json({success:true,assignments:await Assignment.find(filter).sort({year:-1,employeeId:1}).lean()});
}catch(e){fail(res,e);}}
async function assign(req,res){try{
 const employeeId=String(req.body.employeeId||'');
 if(!await assertEmployeeAllowed(req,employeeId))return res.sendStatus(403);
 if(!await Employee.exists({employeeId}))return res.sendStatus(404);
 const {year,profileId}=req.body;
 const reason=typeof req.body.reason==='string'?req.body.reason.trim():'';
 if(!Number.isInteger(year)||year<1900||year>2200||!reason||reason.length>1000)throw Error('Valid year and reason required');
 if(profileId!==null&&!await Profile.exists({_id:profileId}))throw Error('Profile not found');
 const key={employeeId,year};const before=await Assignment.findOne(key).lean();
 const assignment=await Assignment.findOneAndUpdate(key,{$set:{profileId,reason},$setOnInsert:key},{new:true,upsert:true,runValidators:true}).lean();
 await audit(req,'employee.leave.policy.assign',{targetId:String(assignment._id),before,after:assignment});
 res.json({success:true,assignment});
}catch(e){fail(res,e);}}
module.exports={list,create,assignments,assign};
