const { Holiday, Employee } = require('../models');
const { calendarKey, employeeHolidayEligible, holidayOccursOn } = require('../services/holiday.service');
const { assertEmployeeAllowed } = require('../services/access-scope.service');

function normalizeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('date must be YYYY-MM-DD');
  const d = new Date(`${value}T12:00:00`);
  if (Number.isNaN(d.getTime()) || calendarKey(d) !== value) throw new Error('Invalid holiday date');
  d.setHours(0, 0, 0, 0);
  return d;
}
function targeting(body, existing = {}) {
  const appliesTo = body.appliesTo ?? existing.appliesTo ?? (body.type === 'OPTIONAL' ? 'EMPLOYEES' : 'ALL');
  if (!['ALL', 'EMPLOYEES', 'DEPARTMENTS'].includes(appliesTo)) throw new Error('Invalid holiday assignment scope');
  const ids = body.employeeIds ?? existing.employeeIds ?? [];
  const departments = body.departments ?? existing.departments ?? [];
  if (!Array.isArray(ids) || !Array.isArray(departments)) throw new Error('employeeIds and departments must be arrays');
  const employeeIds = [...new Set(ids.map(v => String(v).trim()).filter(Boolean))];
  const cleanDepartments = [...new Set(departments.map(v => String(v).trim()).filter(Boolean))];
  if (appliesTo === 'EMPLOYEES' && !employeeIds.length) throw new Error('Select at least one employee');
  if (appliesTo === 'DEPARTMENTS' && !cleanDepartments.length) throw new Error('Select at least one department');
  if (appliesTo === 'ALL' && (body.type ?? existing.type) === 'OPTIONAL') throw new Error('Optional holidays require selected employees or departments');
  return { appliesTo, employeeIds: appliesTo === 'EMPLOYEES' ? employeeIds : [], departments: appliesTo === 'DEPARTMENTS' ? cleanDepartments : [] };
}
async function validateTargets(target) {
  if (target.appliesTo !== 'EMPLOYEES') return;
  const employees = await Employee.find({ employeeId: { $in: target.employeeIds } }).select('employeeId').lean();
  if (employees.length !== target.employeeIds.length) throw new Error('Some selected employee IDs do not exist');
}
async function list(req, res) {
  try {
    const filter = {};
    if (req.query.active !== undefined) filter.active = String(req.query.active) !== 'false';
    const year = req.query.year == null ? null : Number(req.query.year);
    if (year !== null) {
      if (!Number.isInteger(year) || year < 2000 || year > 2200) return res.status(400).json({ success: false, message: 'Invalid year' });
      filter.$or = [
        { date: { $gte: new Date(year, 0, 1), $lt: new Date(year + 1, 0, 1) } },
        { recurringAnnual: true }
      ];
    }
    let employee = null;
    if (req.query.employeeId) {
      if (!(await assertEmployeeAllowed(req, String(req.query.employeeId)))) return res.status(403).json({ success: false, message: 'Employee outside your data scope' });
      employee = await Employee.findOne({ employeeId: String(req.query.employeeId) }).lean();
      if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    let holidays = await Holiday.find(filter).sort({ date: 1, name: 1 }).lean();
    if (employee) holidays = holidays.filter(h => employeeHolidayEligible(h, employee));
    // recurringDate provides a concrete occurrence for calendar clients.
    const occurrences = year === null ? null : holidays.flatMap(h => {
      if (!h.recurringAnnual) return [{ ...h, occurrenceDate: calendarKey(h.date) }];
      const dates = [];
      for (let month = 0; month < 12; month++) for (let day = 1; day <= 31; day++) {
        const d = new Date(year, month, day);
        if (d.getMonth() === month && holidayOccursOn(h, d)) dates.push({ ...h, occurrenceDate: calendarKey(d) });
      }
      return dates;
    });
    res.json({ success: true, count: holidays.length, holidays, occurrences });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}
async function create(req, res) {
  try {
    const target = targeting(req.body);
    await validateTargets(target);
    const holiday = await Holiday.create({
      name: String(req.body.name || '').trim(), date: normalizeDate(req.body.date),
      type: req.body.type || 'PUBLIC', description: String(req.body.description || ''),
      recurringAnnual: req.body.recurringAnnual === true, active: req.body.active !== false, ...target
    });
    res.status(201).json({ success: true, holiday });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
}
async function update(req, res) {
  try {
    const existing = await Holiday.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Holiday not found' });
    const target = targeting(req.body, existing);
    await validateTargets(target);
    const patch = { ...target };
    for (const name of ['name', 'type', 'description', 'recurringAnnual', 'active']) if (req.body[name] !== undefined) patch[name] = req.body[name];
    if (patch.name !== undefined) patch.name = String(patch.name).trim();
    if (req.body.date !== undefined) patch.date = normalizeDate(req.body.date);
    const holiday = await Holiday.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true, runValidators: true }).lean();
    res.json({ success: true, holiday });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
}
async function remove(req, res) {
  try {
    // Soft removal preserves historic records/auditability.
    const holiday = await Holiday.findByIdAndUpdate(req.params.id, { $set: { active: false } }, { new: true }).lean();
    if (!holiday) return res.status(404).json({ success: false, message: 'Holiday not found' });
    res.json({ success: true, deleted: true, holiday });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}
module.exports = { list, create, update, remove };
