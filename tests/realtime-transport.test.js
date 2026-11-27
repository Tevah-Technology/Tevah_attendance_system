const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const { EventEmitter } = require('events');
const stream = new EventEmitter(); stream.close = async () => {};
const original = Module._load;
const model = name => ({collection:{name}});
const models = new Proxy({}, {get: (_,name) => model(String(name))});
Module._load = function(name,parent,isMain) {
  if (parent?.filename.endsWith('/realtime.service.js')) {
    if (name === 'mongoose') return {connection:{watch:()=>stream}};
    if (name === '../models') return models;
    if (name.startsWith('../models/')) return model(name.split('/').pop());
    if (name === './permission.service') return {hasPermission:(access,p)=>access.permissions.includes(p)};
    if (name === './access-scope.service') return {getAllowedEmployeeIds:async req=>req.ids};
  }
  return original.apply(this,arguments);
};
const service = require('../src/services/realtime.service');
Module._load = original;
service.start();
function request({employeeId='E1',scope='self',cursor='',permissions=['self.attendance.view','self.leave.view'],ids=null,topics='attendance,leave,compensation,notifications'}={}) {
  const req = {user:{_id:employeeId,employeeId},access:{permissions},query:{scope,cursor,topics},ids};
  const res = new EventEmitter();
  res.set=()=>{};res.statusCode=200;res.status=code=>{res.statusCode=code;return res;};
  let settle; const result=new Promise(resolve=>{settle=resolve;});
  res.json=body=>settle({code:res.statusCode,body});
  const registered=service.wait(req,res);
  return {res,result,registered};
}
test('initial reset, scoped change, no data payload, management permission, and cursor isolation',async()=>{
  const initial = await request().result;
  assert.equal(initial.body.reset,true); assert.equal(initial.body.topics.length,4);
  const pending=request({cursor:initial.body.cursor});await pending.registered;
  let resolved=false;pending.result.then(()=>{resolved=true;});
  service.publish('attendance','E2');await new Promise(r=>setImmediate(r));assert.equal(resolved,false);
  service.publish('leave','E1');const changed=await pending.result;
  assert.deepEqual(changed.body.topics,['leave']);assert.equal(changed.body.employeeId,undefined);
  const scoped=await request({scope:'management',permissions:['reports.daily.view'],ids:['E2']}).result;
  const management=request({scope:'management',permissions:['reports.daily.view'],ids:['E2'],cursor:scoped.body.cursor});await management.registered;
  service.publish('attendance','E1');service.publish('attendance','E2');
  assert.deepEqual((await management.result).body.topics,['attendance']);
  const denied=await request({scope:'management',permissions:['self.attendance.view']}).result;assert.equal(denied.code,403);
  const foreign=await request({employeeId:'E2',cursor:initial.body.cursor}).result;assert.equal(foreign.body.reset,true);
  const notice=await request({topics:'notifications'}).result;assert.deepEqual(notice.body.topics,['notifications']);
  const live=request({topics:'notifications',cursor:notice.body.cursor});await live.registered;
  stream.emit('change',{ns:{coll:'EmployeeNotification'},operationType:'insert',documentKey:{_id:'N1'},fullDocument:{employeeId:'E1'}});
  assert.deepEqual((await live.result).body.topics,['notifications']);
});
