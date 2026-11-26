const mongoose = require('mongoose');

const shiftSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    code: {
      type: String,
      default: '',
      trim: true,
    },

    description: {
      type: String,
      default: '',
      trim: true,
    },

    shiftType: { type: String, enum: ['FIXED', 'WORKING_HOURS_ONLY'], default: 'FIXED' },
    maximumSessionMinutes: { type: Number, default: 0, min: 0, max: 1440, validate: Number.isInteger },

    startTime: {
      type: String,
      required: function () { return this.shiftType !== 'WORKING_HOURS_ONLY'; },
      default: '',
      trim: true,
    },

    endTime: {
      type: String,
      required: function () { return this.shiftType !== 'WORKING_HOURS_ONLY'; },
      default: '',
      trim: true,
    },

    // Optional per-shift lunch boundary overrides; global Rules are fallback.
    lunchStartTime: { type: String, default: '', trim: true },
    lunchEndTime: { type: String, default: '', trim: true },

    // Canonical attendance fields
    breakMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },

    requiredMinutes: {
      type: Number,
      default: 480,
      min: 1,
    },

    attendanceUnits: {
      type: Number,
      default: 1,
      min: 0,
      max: 1,
    },

    graceMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },

    overtimeAfterMinutes: {
      type: Number,
      default: 480,
      min: 0,
    },

    overtimeStartTime: {
      type: String,
      default: '',
      trim: true,
    },

    minimumOvertimeMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },

    maximumOvertimeMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },

    overtimeRoundingMinutes: {
      type: Number,
      default: 1,
      min: 1,
    },

    weekdayMinutes: { type: mongoose.Schema.Types.Mixed, default: {} },
    scheduleExceptions: { type: [mongoose.Schema.Types.Mixed], default: [] },
    workingDays: {
      type: [Number],
      default: [1, 2, 3, 4, 5, 6],
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    // Flutter Shift Management compatibility fields
    requiredHours: {
      type: String,
      default: '08:00',
      trim: true,
    },

    isOvernight: {
      type: Boolean,
      default: false,
    },

    breakType: {
      type: String,
      default: 'Flexible',
      trim: true,
    },

    breakDurationMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },

    gracePeriodMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },

    earlyDepartureMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },

    enableOvertime: {
      type: Boolean,
      default: true,
    },

    minOvertimeMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },

    overtimeRounding: {
      type: String,
      default: 'Exact',
      trim: true,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

shiftSchema.index({
  name: 1,
  active: 1,
});

module.exports = mongoose.model('Shift', shiftSchema);