const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  employeeId: { type: String, required: true, index: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
  minutes: { type: Number, required: true, min: 1, max: 1440 },
  reason: { type: String, required: true, trim: true },
  actorId: { type: String, required: true },
  actorEmail: String,
  status: { type: String, enum: ['ACTIVE', 'REVOKED'], default: 'ACTIVE', index: true },
  revokedAt: Date,
  revokedBy: String,
  revokeReason: String
}, { timestamps: true });
schema.index({employeeId:1,date:1,status:1});
module.exports = mongoose.model('AttendanceAdjustment', schema);
