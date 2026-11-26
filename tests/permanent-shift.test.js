const test = require('node:test');
const assert = require('node:assert/strict');
const { Employee, Shift, ShiftAssignment } = require('../src/models');
const controller = require('../src/controllers/shift-assignment.controller');
const eid='507f1f77bcf86cd799439011', sid='507f1f77bcf86cd799439012';
const shift={_id:sid,active:true};
function chain(value){return {select(){return this},populate(){return this},sort(){return this},lean:async()=>value};}
function response(){return {code:200,status(n){this.code=n;return this},json(v){this.body=v;return this}};}
test('permanent assignment requires no date and writes employee default only',async t=>{
 t.mock.method(Shift,'findById',()=>chain(shift));
 t.mock.method(Employee,'findOneAndUpdate',(filter,update)=>{assert.deepEqual(filter,{employeeId:'EMP008'});assert.deepEqual(update,{$set:{shiftId:sid}});return chain({_id:eid,employeeId:'EMP008',shiftId:shift});});
 t.mock.method(ShiftAssignment,'create',()=>{throw Error('must not create temporary assignment')});
 const res=response();await controller.create({body:{employeeId:'EMP008',shiftId:sid,assignmentType:'permanent'}},res);
 assert.equal(res.code,201);assert.equal(res.body.assignment._id,`permanent:${eid}:${sid}`);assert.equal(res.body.assignment.date,null);
});
test('listing includes existing employee defaults',async t=>{
 t.mock.method(ShiftAssignment,'find',()=>chain([]));t.mock.method(Employee,'find',()=>chain([{_id:eid,employeeId:'EMP008',shiftId:shift}]));
 const res=response();await controller.list({query:{}},res);assert.equal(res.body.count,1);assert.equal(res.body.assignments[0].assignmentType,'permanent');
});
test('permanent removal compares existing shift and does not remove a replacement',async t=>{
 t.mock.method(Employee,'updateOne',async (filter,update)=>{assert.deepEqual(filter,{_id:eid,shiftId:sid});assert.deepEqual(update,{$set:{shiftId:null}});return {modifiedCount:0};});
 const res=response();await controller.remove({params:{id:`permanent:${eid}:${sid}`}},res);assert.equal(res.body.deleted,false);
});
