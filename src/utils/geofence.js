const {validateWebLocation}=require('./web-location');
function distanceMeters(a,b,c,d) {
 const toRad=x=>x*Math.PI/180;
 const h=Math.sin(toRad(c-a)/2)**2+Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(toRad(d-b)/2)**2;
 return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}
function zones(rule) {
 if (Array.isArray(rule.geofenceLocations) && rule.geofenceLocations.length) {
  return rule.geofenceLocations.filter(z=>z.enabled!==false).map((z,i)=>({name:z.name,latitude:z.latitude,longitude:z.longitude,radiusMeters:z.radiusMeters}));
 }
 if (Number.isFinite(rule.geofenceLatitude) && Number.isFinite(rule.geofenceLongitude)) {
  return [{name:'Main Office',latitude:rule.geofenceLatitude,longitude:rule.geofenceLongitude,radiusMeters:rule.geofenceRadiusMeters}];
 }
 return [];
}
function evaluate(rule,loc) {
 if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude) || !Number.isFinite(loc.accuracyMeters)) throw new Error('Valid location is required');
 const available=zones(rule);
 if(!available.length)throw new Error('No active geofence locations configured');
 const accuracy=loc.accuracyMeters;
 const accurate=accuracy<=rule.geofenceMaxAccuracyMeters;
 const candidates=available.map(z=>({name:z.name,latitude:z.latitude,longitude:z.longitude,radiusMeters:z.radiusMeters,distanceMeters:distanceMeters(loc.latitude,loc.longitude,z.latitude,z.longitude)}));
 const inside=candidates.find(z=>z.distanceMeters+accuracy<=z.radiusMeters);
 const nearest=candidates.reduce((a,b)=>(a.distanceMeters-a.radiusMeters)<=(b.distanceMeters-b.radiusMeters)?a:b);
 const chosen=inside||nearest;
 const allowed=accurate && Boolean(inside);
 // EXIT is confirmed only when the complete uncertainty area is outside EVERY zone.
 const outsideAll=accurate && candidates.every(z=>z.distanceMeters-accuracy>z.radiusMeters);
 const reason=!accurate?'Location accuracy is too low':allowed?'Inside permitted geofence':outsideAll?'Outside all office geofences':'GPS uncertainty overlaps office boundary';
 return {allowed,outsideAll,reason,locationName:chosen.name,distanceMeters:Math.round(chosen.distanceMeters),accuracyMeters:accuracy,radiusMeters:chosen.radiusMeters};
}
function validateForAttendance(body,rule,action) {
 const enforce=rule.geofenceEnabled===true && (action==='in'?rule.geofenceCheckIn!==false:rule.geofenceCheckOut!==false);
 const location=validateWebLocation(body,enforce||rule.webLocationRequired===true);
 if(!enforce)return {location,geofence:null};
 const result=evaluate(rule,location);
 if(!result.allowed){const e=new Error(`${result.reason}. Distance ${result.distanceMeters} m; radius ${result.radiusMeters} m`);e.status=422;throw e;}
 return {location,geofence:{verified:true,...result,verifiedAt:new Date().toISOString()}};
}
module.exports={distanceMeters,zones,evaluate,validateForAttendance};
