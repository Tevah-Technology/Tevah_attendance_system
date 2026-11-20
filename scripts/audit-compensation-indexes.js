'use strict';
// Read-only by default. Review results and back up Atlas before --apply.
require('dotenv').config();
const mongoose = require('mongoose');
const { Compensation } = require('../src/models');
const expected = [
  'one_pending_hour_credit_per_target_day',
  'one_pending_late_credit_per_target_day',
  'one_approved_hour_credit_per_target_day',
  'one_approved_late_credit_per_target_day'
];
(async()=>{
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  try {
    const collection=Compensation.collection;
    const indexes=await collection.indexes();
    const existing=new Set(indexes.map(index=>index.name));
    console.log('Existing compensation indexes:');
    for(const name of expected) console.log(`${existing.has(name)?'OK':'MISSING'}: ${name}`);
    const duplicateGroups=[];
    for(const [label, field, value, status] of [
      ['pending hour','creditBucket','HOURS','PENDING'],
      ['pending late','lateBucket','LATE','PENDING'],
      ['approved hour','creditBucket','HOURS','APPROVED'],
      ['approved late','lateBucket','LATE','APPROVED']
    ]){
      const found=await collection.aggregate([
        { $match:{status,[field]:value}},
        { $group:{_id:{employeeId:'$employeeId',date:'$date'},count:{$sum:1}}},
        { $match:{count:{$gt:1}}}, {$sort:{count:-1}}, {$limit:20}
      ]).toArray();
      console.log(`${label} duplicate employee/date groups: ${found.length}${found.length===20?' (first 20 only)':''}`);
      for(const row of found) console.log('  ',JSON.stringify(row));
      if(found.length) duplicateGroups.push(label);
    }
    if(process.argv.includes('--apply')){
      if(duplicateGroups.length) throw new Error(`Cannot create indexes: duplicate groups found (${duplicateGroups.join(', ')})`);
      // Approved indexes already exist in schema; only build new pending indexes here.
      for(const name of expected.filter(name=>name.startsWith('one_pending_'))){
        if(existing.has(name)) continue;
        const def=Compensation.schema.indexes().find(([,options])=>options.name===name);
        if(!def) throw new Error(`Missing schema index ${name}`);
        await collection.createIndex(def[0],def[1]);
        console.log('CREATED:',name);
      }
    }else{
      console.log('READ ONLY: no indexes created. To apply after review/backup, run this script with --apply.');
    }
  }finally{await mongoose.disconnect();}
})().catch(e=>{console.error('Index audit failed:',e.message);process.exitCode=1;});
