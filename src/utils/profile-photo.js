const MAX_PHOTO_BYTES = 128 * 1024;
function validProfilePhoto(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 174800) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES || bytes.toString('base64') !== match[2]) return false;
  if (match[1] === 'png') return bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 2048 && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 2048;
  if (match[1] === 'jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length-2] === 255 && bytes[bytes.length-1] === 217;
  return bytes.length >= 16 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length;
}
function validAvatarGender(value) { return ['male','female'].includes(value); }
module.exports = { validProfilePhoto, validAvatarGender, MAX_PHOTO_BYTES };
