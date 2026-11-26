'use strict';
// Dry run by default. Back up the database before applying.
require('dotenv').config();
const mongoose = require('mongoose');
const Employee = require('../src/models/Employee');
async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri, { autoIndex: false });
  try {
    const filter = { gender: { $in: ['unspecified', 'neutral', '', null], $exists: true } };
    console.log('Database:', mongoose.connection.name);
    console.log('Legacy avatar preferences:', await Employee.collection.countDocuments(filter));
    if (process.argv.includes('--apply')) {
      const result = await Employee.collection.updateMany(filter, { $unset: { gender: '' } });
      console.log('Removed legacy preferences:', result.modifiedCount);
    } else console.log('Dry run only. Use --apply after reviewing and backing up.');
  } finally { await mongoose.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
