const { Employee } = require('../models');
const { buildReport, aggregate } = require('../services/report.service');
const { syncAttendance } = require('../services/attendance.service');
const deviceService = require('../services/device.service');
const { getAllowedEmployeeIds } = require('../services/access-scope.service');

function dedupeRowsByEmployee(rows) {
  const unique = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.employeeId || row?.id || '').trim();
    if (!key) continue;

    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, row);
      continue;
    }

    // Preserve the richer row if a duplicate somehow arrives.
    unique.set(key, {
      ...existing,
      ...Object.fromEntries(
        Object.entries(row).filter(([, value]) => value !== null && value !== undefined && value !== '')
      )
    });
  }

  return Array.from(unique.values());
}

async function summary(req, res) {
  try {
    const date = req.query.date || new Date();
    const employeeIds = await getAllowedEmployeeIds(req);

    const rows = await buildReport({
      from: date,
      to: date,
      employeeIds
    });

    const data = dedupeRowsByEmployee(rows);
    const summaryData = aggregate(data);

    const permissions = Array.isArray(req.access?.permissions)
      ? req.access.permissions
      : [];

    const canViewDevice =
      permissions.includes('*') ||
      permissions.includes('dashboard.deviceHealth.view') ||
      permissions.includes('operations.deviceHealth.view') ||
      permissions.includes('device.view') ||
      req.access?.roleCode === 'SUPER_ADMIN';

    const device = canViewDevice
      ? await deviceService.getInfo().catch(() => null)
      : null;

    let employees;

    if (employeeIds === null) {
      const activeEmployeeIds = await Employee.distinct('employeeId', { active: true });
      employees = activeEmployeeIds
        .map((id) => String(id || '').trim())
        .filter(Boolean).length;
    } else {
      employees = new Set(
        employeeIds
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      ).size;
    }

    const present = data.filter((row) => row.status === 'PRESENT').length;
    const absent = data.filter((row) => row.status === 'ABSENT').length;
    const leave = data.filter((row) => row.status === 'LEAVE').length;
    const late = data.filter((row) => Number(row.lateMinutes || 0) > 0).length;
    const overtime = data.filter((row) => Number(row.overtimeMinutes || 0) > 0).length;

    const attendanceRatio = employees > 0 ? (present / employees) * 100 : 0;

    return res.json({
      success: true,
      date,
      employees,
      totalHeadcount: employees,
      present,
      presentToday: present,
      absent,
      absentees: absent,
      leave,
      approvedLeaves: leave,
      late,
      lateArrivals: late,
      overtime,
      activeOvertime: overtime,
      attendanceRatio,
      summary: summaryData,
      data,
      device
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

async function sync(req, res) {
  try {
    return res.json({ success: true, result: await syncAttendance() });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = { summary, sync };
