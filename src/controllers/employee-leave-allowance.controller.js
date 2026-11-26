const Allowance=require('../models/EmployeeLeaveAllowance');
const {Employee,LeaveType}=require('../models');
const {validateAllowance}=require('../services/employee-leave-allowance.service');
const {assertEmployeeAllowed,restrictEmployeeFilter}=require('../services/access-scope.service');
const {audit}=require('../middleware/auth');
async function list(req,res){try{
 const filter=await restrictEmployeeFilter(req,req.query.employeeId?{employeeId:String(req.query.employeeId)}:{});
 if(req.query.year){const year=Number(req.query.year);if(!Number.isInteger(year)||year<1900||year>2200)throw Error('Invalid year');filter.year=year;}
 res.json({success:true,allowances:await Allowance.find(filter).sort({year:-1,employeeId:1}).lean()});
}catch(e){res.status(400).json({success:false,message:e.message});}}
async function save(req,res){try{
 const employeeId=String(req.body.employeeId||'');
 if(!await assertEmployeeAllowed(req,employeeId))return res.sendStatus(403);
 const values=validateAllowance(req.body);
 if(!await Employee.exists({employeeId}))return res.sendStatus(404);
 const type=await LeaveType.findOne({_id:req.body.leaveTypeId,active:true}).lean();
 if(!type)return res.status(404).json({success:false,message:'Active leave type not found'});
 const key={employeeId,leaveTypeId:type._id,year:values.year};
 const before=await Allowance.findOne(key).lean();
 const allowance=await Allowance.findOneAndUpdate(key,{$set:{annualAllocation:values.annualAllocation,reason:values.reason},$setOnInsert:key},{upsert:true,new:true,runValidators:true}).lean();
 await audit(req,'employee.leave.allowance.save',{targetId:String(allowance._id),before,after:allowance});
 res.json({success:true,allowance});
}catch(e){res.status(400).json({success:false,message:e.message});}}
module.exports={list,save};
