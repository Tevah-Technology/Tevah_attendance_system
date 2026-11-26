const mongoose = require('mongoose');
const { validProfilePhoto, validAvatarGender } = require('../utils/profile-photo');

const employeeSchema = new mongoose.Schema(
  {
    // ========================================================
    // EMPLOYEE INFORMATION
    // ========================================================

    employeeId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true
    },

    name: {
      type: String,
      required: true,
      trim: true
    },

    department: {
      type: String,
      default: '',
      trim: true
    },

    designation: {
      type: String,
      default: '',
      trim: true
    },

    phone: {
      type: String,
      default: ''
    },

    email: {
      type: String,
      default: ''
    },

    gender: {
      type: String,
      enum: ['male', 'female'],
      // Missing gender is an unset preference, not a third option.
      validate: validAvatarGender
    },

    profilePhoto: {
      type: String,
      default: '',
      validate: { validator: validProfilePhoto, message: 'Invalid profile photo (PNG/JPEG/WebP, maximum 128 KB)' }
    },

    // Employment dates used by leave-policy validation.
    dateOfJoining: {
      type: Date,
      default: null
    },

    probationEndDate: {
      type: Date,
      default: null
    },

    noticePeriodStartDate: {
      type: Date,
      default: null
    },

    // ========================================================
    // ZKTECO DEVICE INFORMATION
    // ========================================================

    deviceIp: {
      type: String,
      default: ''
    },

    // Internal numeric UID used by the F28
    deviceUid: {
      type: Number,
      default: null,
      index: true
    },

    // User ID stored on the F28
    deviceUserId: {
      type: String,
      default: ''
    },

    // Card number
    cardNo: {
      type: Number,
      default: 0
    },

    // ZKTeco privilege / role
    deviceRole: {
      type: Number,
      default: 0
    },

    // ========================================================
    // FINGERPRINT INFORMATION
    // ========================================================

    fingerprintEnrolled: {
      type: Boolean,
      default: false
    },

    fingerprintIds: {
      type: [Number],
      default: []
    },

    // ========================================================
    // SHIFT
    // ========================================================

    timezone: { type: String, default: null, validate: v => v == null || require('../utils/employee-time').validZone(v) },
    ruleProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceRuleProfile', default: null },
    holidayCalendarAssignments: {type:[new mongoose.Schema({year:Number,profileId:{type:mongoose.Schema.Types.ObjectId,ref:'HolidayCalendarProfile',default:null},mode:{type:String,enum:['company','custom','both','none']},reason:String},{_id:false})],default:[]},
    ruleOverrides: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

    shiftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shift',
      default: null
    },

    // ========================================================
    // STATUS
    // ========================================================

    active: {
      type: Boolean,
      default: true,
      index: true
    }
  },
  {
    timestamps: true
  }
);

module.exports =
  mongoose.model(
    'Employee',
    employeeSchema
  );