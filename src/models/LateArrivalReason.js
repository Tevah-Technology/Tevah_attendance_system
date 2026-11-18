const mongoose = require('mongoose');

// Employee explanation is NOT an attendance adjustment or approval of lateness.
const schema = new mongoose.Schema({
  employeeId: { type: String, required: true, index: true, trim: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  firstIn: { type: Date, required: true },
  lateMinutesAtSubmission: { type: Number, required: true, min: 1 },
  reason: { type: String, required: true, minlength: 5, maxlength: 1000 },
  status: { type: String, enum: ['SUBMITTED', 'REVIEWED'], default: 'SUBMITTED', index: true },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, maxlength: 1000, default: '' },
  history: [{ action: String, actorId: mongoose.Schema.Types.ObjectId, at: { type: Date, default: Date.now }, note: String }]
}, { timestamps: true });
schema.index({ employeeId: 1, date: 1 }, { unique: true });
module.exports = mongoose.model('LateArrivalReason', schema);
