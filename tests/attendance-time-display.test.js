const {test}=require('node:test');
const assert=require('node:assert/strict');
const {withAttendanceDisplay}=require('../src/utils/attendance-time-display');
test('Dubai and IST preserve UTC; absent checkout stays null',()=>{
 const row={timezone:'Asia/Dubai',firstIn:new Date('2026-11-27T05:00:00Z'),lastOut:null,punches:[]};
 const out=withAttendanceDisplay(row);
 assert.equal(out.firstIn,row.firstIn);assert.equal(out.firstInLocal,'09:00 AM');assert.equal(out.firstInIST,'10:30 AM');assert.equal(out.lastOutIST,null);
});
test('DST and next-day IST are explicit',()=>{
 const row=withAttendanceDisplay({timezone:'America/New_York',firstIn:'2026-07-01T13:00:00Z',lastOut:'2026-07-01T21:00:00Z'});
 assert.equal(row.firstInLocal,'09:00 AM');assert.equal(row.lastOutIST,'02:30 AM');assert.equal(row.lastOutISTDate,'2026-07-02');
});
