const {addDay}=require('../utils/employee-time');
function recurringDates({startDate,endDate,weekdays}){
 const valid=k=>typeof k==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(k)&&Number.isFinite(Date.parse(k+'T00:00:00Z'))&&new Date(k+'T00:00:00Z').toISOString().slice(0,10)===k;
 if(!valid(startDate)||!valid(endDate)||endDate<startDate||startDate.slice(0,4)!==endDate.slice(0,4))throw Error('Select a bounded date range within one calendar year');
 if(!Array.isArray(weekdays)||!weekdays.length||!weekdays.every(x=>Number.isInteger(x)&&x>=1&&x<=7))throw Error('Select weekdays 1–7');
 const dates=[];for(let d=startDate;d<=endDate;d=addDay(d)){if(weekdays.includes(new Date(d+'T00:00:00Z').getUTCDay()||7))dates.push(d);}
 if(!dates.length)throw Error('No matching dates');return dates;
}
module.exports={recurringDates};
