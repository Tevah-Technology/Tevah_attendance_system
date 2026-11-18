'use strict';
// Run once during a scheduled maintenance window after backing up MongoDB.
// Dry-run by default: npm run migrate:overtime
// Apply: npm run migrate:overtime -- --apply
require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  const collection = db.collection('compensations');
  const indexes = await collection.indexes();
  const name = 'one_approved_transfer_per_source_day';
  const found = indexes.some(i => i.name === name);
  console.log('Legacy one-transfer-per-source-day index:', found ? 'present' : 'absent');
  if (found && process.argv.includes('--apply')) {
    await collection.dropIndex(name);
    console.log('Dropped legacy source-date uniqueness index. OvertimeBalance is the new source of truth.');
  } else if (found) {
    console.log('Dry run only. Review backups and maintenance plan before rerunning with --apply.');
  }
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('Migration failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
