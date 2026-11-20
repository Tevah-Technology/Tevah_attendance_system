'use strict';
// READ ONLY: inspect actual compensation indexes and duplicate groups.
require('dotenv').config();
const mongoose = require('mongoose');
const { Compensation } = require('../src/models');
(async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  try {
    const collection = Compensation.collection;
    const existing = new Set((await collection.indexes()).map(i => i.name));
    console.log('Expected indexes:');
    for (const [, options] of Compensation.schema.indexes()) {
      if (options.name && (options.name.includes('credit') || options.name.includes('late') || options.name.includes('separate'))) {
        console.log(existing.has(options.name) ? 'OK' : 'MISSING', options.name);
      }
    }
    const checks = [
      ['PENDING hours', {status:'PENDING',creditBucket:'HOURS'}, '$creditBucket'],
      ['APPROVED hours', {status:'APPROVED',creditBucket:'HOURS'}, '$creditBucket'],
      ['PENDING late', {status:'PENDING',lateBucket:'LATE'}, '$lateBucket'],
      ['APPROVED late', {status:'APPROVED',lateBucket:'LATE'}, '$lateBucket'],
      ['PENDING separate (including legacy)', {status:'PENDING',creditMode:'SEPARATE'}, '$type'],
      ['APPROVED separate (including legacy)', {status:'APPROVED',creditMode:'SEPARATE'}, '$type']
    ];
    for (const [label, match, groupBy] of checks) {
      const groups = await collection.aggregate([
        {$match:match},
        {$group:{_id:{employeeId:'$employeeId',date:'$date',bucket:groupBy},count:{$sum:1}}},
        {$match:{count:{$gt:1}}},{$limit:20}
      ]).toArray();
      console.log(label, 'duplicate groups:', groups.length);
      for (const x of groups) console.log(JSON.stringify(x));
    }
    console.log('READ ONLY. No migrations or indexes were created.');
  } finally { await mongoose.disconnect(); }
})().catch(e=>{ console.error(e.message); process.exitCode=1; });
