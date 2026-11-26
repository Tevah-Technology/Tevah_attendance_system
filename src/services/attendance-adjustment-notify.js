const {EmployeeNotification} = require('../models');
const {notifyEmployee} = require('./notification.service');
async function createNotice(employeeId, kind, title, message, metadata={}) {
 const notice = await EmployeeNotification.create({employeeId,kind,title,message,metadata});
 // In-app delivery succeeds even if external email/WhatsApp is unavailable.
 try { await notifyEmployee(employeeId,'attendanceAdjustment',title,message); }
 catch(err) { console.warn('External attendance notification unavailable:',err.message); }
 return notice;
}
module.exports={createNotice};
