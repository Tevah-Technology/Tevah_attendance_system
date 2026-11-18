const mongoose = require('mongoose');

// A separate, append-only approval trail. No biometric punch is rewritten.
const eventSchema = new mongoose.Schema({
  action: { type: String, required: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true },
  actorEmail: { type: String, default: '' },
  reason: { type: String, default: '' },
  at: { type: Date, default: Date.now }
}, { _id: false });
const schema = new mongoose.Schema({
  employeeId: { type: String, required: true, index: true },
  date: { type: String, required: true, index: true }, // business-local YYYY-MM-DD
  type: { type: String, required: true, enum: ['MISSING_HOURS', 'EXTRA_HOURS_TRANSFER', 'LATE_ARRIVAL'] },
  minutes: { type: Number, required: true, min: 1, max: 720 },
  sourceDate: { type: String, default: null },
  creditBucket: { type: String, default: null },
  creditMode: { type: String, enum: ['MERGE', 'SEPARATE'], default: 'MERGE' },
  origin: { type: String, enum: ['ADMIN', 'EMPLOYEE'], default: 'ADMIN' },
  lateBucket: { type: String, default: null },
  reason: { type: String, required: true },
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'], default: 'PENDING', index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  decidedAt: { type: Date, default: null },
  decisionReason: { type: String, default: '' },
  history: { type: [eventSchema], default: [] }
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ employeeId: 1, date: 1, status: 1 });
// Avoid concurrent late approvals exceeding the eligible late amount.
schema.index({ employeeId: 1, date: 1, lateBucket: 1 }, {
  unique: true, partialFilterExpression: { status: 'APPROVED', lateBucket: 'LATE' },
  name: 'one_approved_late_credit_per_target_day'
});
// Serialize all approved *hour credits* on a target day, avoiding concurrent over-credit.
schema.index({ employeeId: 1, date: 1, creditBucket: 1 }, {
  unique: true, partialFilterExpression: { status: 'APPROVED', creditBucket: 'HOURS' },
  name: 'one_approved_hour_credit_per_target_day'
});
// Source overtime is protected instead by the transactionally updated
// OvertimeBalance; multiple partial transfers to different dates are allowed.
module.exports = mongoose.model('Compensation', schema);
