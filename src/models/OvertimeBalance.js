const mongoose = require('mongoose');
// Atomic per-employee/per-source-day overtime budget, backing admin transfers.
// Approved transfers are also recorded as Compensation rows for audit/reporting.
const schema = new mongoose.Schema({
  employeeId: { type: String, required: true },
  sourceDate: { type: String, required: true },
  earnedMinutes: { type: Number, required: true, default: 0, min: 0 },
  usedMinutes: { type: Number, required: true, default: 0, min: 0 }
}, { timestamps: true });
schema.index({ employeeId: 1, sourceDate: 1 }, { unique: true, name: 'unique_employee_overtime_day' });
module.exports = mongoose.model('OvertimeBalance', schema);
