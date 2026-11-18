const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  deviceIp: { type: String, required: true },
  userId: { type: String, required: true },
  employeeId: { type: String, required: true, index: true },
  timestamp: { type: Date, required: true },
  attemptedPunchType: { type: String, default: 'IN' },
  reason: { type: String, required: true },
  rawData: mongoose.Schema.Types.Mixed
}, { timestamps: true });
schema.index({ deviceIp: 1, userId: 1, timestamp: 1 }, { unique: true });
module.exports = mongoose.model('RejectedPunch', schema);
