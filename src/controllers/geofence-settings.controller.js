const {Rule}=require('../models');
const {validateWebLocation}=require('../utils/web-location');
const {evaluate,zones}=require('../utils/geofence');
const fields=['geofenceLocations','geofenceEnabled','geofenceCheckIn','geofenceCheckOut','geofenceLatitude','geofenceLongitude','geofenceRadiusMeters','geofenceMaxAccuracyMeters','autoGeofenceEnabled','autoGeofenceCheckIn','autoGeofenceCheckOut','autoGeofenceExitDelaySeconds'];
const booleans=['geofenceEnabled','geofenceCheckIn','geofenceCheckOut','autoGeofenceEnabled','autoGeofenceCheckIn','autoGeofenceCheckOut'];
const view=r=>Object.fromEntries(fields.map(k=>[k,r[k]??null]));
async function current(){return (await Rule.findOne())||(await Rule.create({}));}
async function get(req,res){try{res.json({success:true,geofence:view(await current())});}catch(e){res.status(500).json({success:false,message:'Could not load geofence settings'});}}
async function update(req,res){
 try {
 const body=req.body;
 if(!body||typeof body!=='object'||Array.isArray(body)||!Object.keys(body).length||Object.keys(body).some(k=>!fields.includes(k)))return res.status(400).json({success:false,message:'Unknown geofence settings'});
 const rule=await current();
 const proposed={...view(rule),...body};
 for(const [key,value] of Object.entries(body)){
   if(key==='geofenceLocations')continue;
   if(booleans.includes(key)){if(typeof value!=='boolean')throw new Error(key+' must be boolean');}
   else if(value!==null&&(typeof value!=='number'||!Number.isFinite(value)))throw new Error(key+' must be numeric');
 }
 if(Object.prototype.hasOwnProperty.call(body,'geofenceLocations')){
   const list=body.geofenceLocations;
   if(!Array.isArray(list)||list.length>100)throw new Error('geofenceLocations must be an array of at most 100 locations');
   const seen=new Set();
   for(const z of list){
     if(!z||typeof z!=='object'||Array.isArray(z)||Object.keys(z).some(k=>!['name','latitude','longitude','radiusMeters','enabled'].includes(k)))throw new Error('Invalid geofence location');
     if(typeof z.name!=='string'||!z.name.trim()||z.name.length>100)throw new Error('Location name required (max 100 characters)');
     const name=z.name.trim().toLowerCase();if(seen.has(name))throw new Error('Location names must be unique');seen.add(name);
     if(!Number.isFinite(z.latitude)||z.latitude< -90||z.latitude>90||!Number.isFinite(z.longitude)||z.longitude< -180||z.longitude>180)throw new Error('Invalid location coordinates');
     if(!Number.isFinite(z.radiusMeters)||z.radiusMeters<25||z.radiusMeters>5000)throw new Error('Location radius must be 25 to 5000 metres');
     if(z.enabled!==undefined&&typeof z.enabled!=='boolean')throw new Error('Location enabled must be boolean');
   }
 }
 const lat=proposed.geofenceLatitude,lon=proposed.geofenceLongitude,rad=proposed.geofenceRadiusMeters,acc=proposed.geofenceMaxAccuracyMeters;
 if(lat!==null&&(!Number.isFinite(lat)||lat< -90||lat>90))throw new Error('Latitude must be -90 to 90');
 if(lon!==null&&(!Number.isFinite(lon)||lon< -180||lon>180))throw new Error('Longitude must be -180 to 180');
 if(!Number.isFinite(rad)||rad<25||rad>5000)throw new Error('Radius must be 25 to 5000 metres');
 if(!Number.isFinite(acc)||acc<5||acc>500)throw new Error('Accuracy must be 5 to 500 metres');
 if(proposed.geofenceEnabled&&(!zones(proposed).length||(!proposed.geofenceCheckIn&&!proposed.geofenceCheckOut)))throw new Error('Set office coordinates and at least one enforcement switch before enabling');
 if(proposed.autoGeofenceEnabled && (!proposed.geofenceEnabled || !zones(proposed).length || (!proposed.autoGeofenceCheckIn && !proposed.autoGeofenceCheckOut)))throw new Error('Enable office geofencing and an automatic event direction before enabling automatic attendance');
 if(!Number.isInteger(proposed.autoGeofenceExitDelaySeconds) || proposed.autoGeofenceExitDelaySeconds<30 || proposed.autoGeofenceExitDelaySeconds>600)throw new Error('Exit delay must be between 30 and 600 seconds');
 for(const [k,v] of Object.entries(body))rule.set(k,v);
 await rule.save();
 console.info('[GEOFENCE] Settings changed by',String(req.user?._id||'authenticated user'));
 res.json({success:true,geofence:view(rule)});
 }catch(e){res.status(400).json({success:false,message:e.message});}
}
async function test(req,res){try{const location=validateWebLocation(req.body,true);const result=evaluate(await current(),location);res.json({success:true,...result});}catch(e){res.status(400).json({success:false,message:e.message});}}
module.exports={get,update,test};
