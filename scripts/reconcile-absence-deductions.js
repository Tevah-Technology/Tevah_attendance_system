require('dotenv').config();
const mongoose=require('mongoose');
(async()=>{try{await require('../src/config/database').connectDatabase(); const changes=await require('../src/services/absence-deduction.service').reconcile({apply:process.argv.includes('--apply')});console.log(JSON.stringify({applied:process.argv.includes('--apply'),changes},null,2));}catch(e){console.error(e.message);process.exitCode=1;}finally{await mongoose.disconnect();}})();
