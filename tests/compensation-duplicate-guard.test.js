'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Compensation, Employee, AuditLog } = require('../src/models');
const controller = require('../src/controllers/compensation.controller');

function response() {
  return {
    code: 200, body: null,
    status(n) { this.code = n; return this; },
    json(j) { this.body = j; return this; }
  };
}
function request(overrides={}) {
  return { user: { _id: '507f191e810c19729de860ea', email:'admin@example.invalid' },
    access: { roleCode: 'SUPER_ADMIN', permissions: ['attendance.compensation.request'] },
    body: { employeeId: 'EMP007', date: '2026-11-09', type:'MISSING_HOURS', minutes: 30,
      reason:'Missed time', creditMode:'MERGE' },
    method:'POST', originalUrl:'/api/compensations', ip:'127.0.0.1', ...overrides };
}
function mock(models) {
  const originals = {
    findOne: Compensation.findOne,
    create: Compensation.create,
    exists: Employee.exists,
    audit: AuditLog.create
  };
  Compensation.findOne = function(filter) { return { select() { return { lean: async()=>models.findOne(filter) }; } }; };
  Compensation.create = async (record) => models.create(record);
  Employee.exists = async()=>true;
  AuditLog.create = async()=>({});
  return ()=>{
    Compensation.findOne=originals.findOne; Compensation.create=originals.create;
    Employee.exists=originals.exists; AuditLog.create=originals.audit;
  };
}

test('pending hourly request blocks a second admin request', async()=>{
  const restore=mock({findOne: async(filter)=>{
    assert.equal(filter.creditBucket,'HOURS');
    assert.deepEqual(filter.status.$in,['PENDING','APPROVED']);
    return {status:'PENDING'};
  },create:()=>{throw Error('should not create');}});
  try {const res=response();await controller.create(request(),res);
    assert.equal(res.code,409); assert.match(res.body.message,/pending/);
  } finally {restore();}
});
test('approved hourly request blocks a second admin request', async()=>{
  const restore=mock({findOne:async()=>({status:'APPROVED'}),create:()=>{throw Error('should not create');}});
  try {const res=response();await controller.create(request(),res);
    assert.equal(res.code,409); assert.match(res.body.message,/Revoke/);
  } finally {restore();}
});
test('revoked credit does not block a new request', async()=>{
  const restore=mock({findOne:async()=>null, create:async(item)=>({...item,status:'PENDING',_id:'507f191e810c19729de860eb'})});
  try {const res=response();await controller.create(request(),res);
    assert.equal(res.code,201); assert.equal(res.body.compensation.status,'PENDING');
  } finally {restore();}
});
test('pending late arrival blocks a duplicate late request, separate from hour credits',async()=>{
  const restore=mock({findOne:async(filter)=>{
    assert.equal(filter.lateBucket,'LATE');
    return {status:'PENDING'};
  },create:()=>{throw Error('should not create');}});
  try {const req=request({body:{employeeId:'EMP007',date:'2026-11-09',type:'LATE_ARRIVAL',minutes:15,reason:'Traffic'}});
    const res=response();await controller.create(req,res);assert.equal(res.code,409);
  }finally{restore();}
});
test('database indexes cover pending and approved hour/late credit buckets',()=>{
  const names = new Map(Compensation.schema.indexes().map(([keys,opts])=>[opts.name,{keys,opts}]));
  for(const [name,status,bucket] of [
    ['one_pending_hour_credit_per_target_day','PENDING','HOURS'],
    ['one_pending_late_credit_per_target_day','PENDING','LATE'],
    ['one_approved_hour_credit_per_target_day','APPROVED','HOURS'],
    ['one_approved_late_credit_per_target_day','APPROVED','LATE']
  ]){
    assert.ok(names.has(name),name);
    const {opts}=names.get(name);
    assert.equal(opts.unique,true);
    assert.equal(opts.partialFilterExpression.status,status);
    assert.equal(opts.partialFilterExpression[bucket==='HOURS'?'creditBucket':'lateBucket'],bucket);
  }
});
