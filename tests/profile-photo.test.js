const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validProfilePhoto, validAvatarGender } = require('../src/utils/profile-photo');
test('empty photo resets avatar; invalid types or formats are rejected', () => {
  assert.equal(validProfilePhoto(''), true);
  for (const value of [null, {}, 'https://example.com/x.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AAAA', 'data:image/jpeg;base64,%%%%']) assert.equal(validProfilePhoto(value), false);
});
test('PNG header and dimensions checked; noncanonical or oversized photo rejected', () => {
  const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write('IHDR',12); png.writeUInt32BE(512,16); png.writeUInt32BE(512,20);
  const uri = () => `data:image/png;base64,${png.toString('base64')}`;
  assert.equal(validProfilePhoto(uri()), true);
  png.writeUInt32BE(99999,16); assert.equal(validProfilePhoto(uri()), false);
  assert.equal(validProfilePhoto('data:image/jpeg;base64,' + 'A'.repeat(180000)), false);
});
test('avatar selection is explicit, not inferred', () => { for(const g of ['male','female']) assert.equal(validAvatarGender(g),true); for (const value of ['unknown', 'neutral', 'unspecified', '', null, undefined]) assert.equal(validAvatarGender(value), false); });
