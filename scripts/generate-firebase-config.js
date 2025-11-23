/**
 * Generate firebase-config.json from environment variables.
 * Usage: ensure the following env vars are set (for example via Codespaces repository secrets):
 *  - FIREBASE_API_KEY
 *  - FIREBASE_AUTH_DOMAIN
 *  - FIREBASE_DATABASE_URL
 *  - FIREBASE_PROJECT_ID
 *  - FIREBASE_STORAGE_BUCKET
 *  - FIREBASE_MESSAGING_SENDER_ID
 *  - FIREBASE_APP_ID
 * Then run: npm run gen-config
 */

const fs = require('fs');
const path = require('path');

const required = [
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_DATABASE_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID'
];

const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('Missing environment variables:', missing.join(', '));
  console.error('Set them in your Codespace or CI environment before running this script.');
  process.exit(2);
}

const cfg = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

const outPath = path.join(process.cwd(), 'firebase-config.json');
fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8' });
console.log('Wrote', outPath);
