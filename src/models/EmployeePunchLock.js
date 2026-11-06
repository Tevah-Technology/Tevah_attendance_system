const mongoose = require('mongoose');
// Best-effort distributed lock for competing scheduler, web and device writers.
// Requires a single MongoDB primary; the unique employeeId index is essential.
const schema = new mongoose.Schema({
  employeeId: { type: String, required: true, unique: true },
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true }
}, { versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('EmployeePunchLock', schema);
