'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const file = path.resolve(__dirname, '../../.env.go-shadow');
const values = {
  SHADOW_SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
  SHADOW_DB_PASSWORD: crypto.randomBytes(24).toString('hex'),
  SHADOW_CREDENTIAL_KEYS: JSON.stringify({'shadow-v1':crypto.randomBytes(32).toString('base64')}),
};
try {
  fs.writeFileSync(file, Object.entries(values).map(([key,value])=>`${key}=${value}\n`).join(''), {flag:'wx',mode:0o600});
  console.log('Created isolated shadow secrets in .env.go-shadow');
} catch (error) {
  if(error.code !== 'EEXIST') throw error;
  console.log('Keeping existing .env.go-shadow secrets');
}
fs.chmodSync(file,0o600);
