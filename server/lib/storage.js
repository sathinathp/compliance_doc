'use strict';
// Private document storage. Files are encrypted by Aegis (AES-256-GCM with AEGIS_SECRET) and
// kept under AEGIS_DATA/documents/<tenant>/. Back that folder up together with the database.
// Every read and write goes through this file, so moving documents somewhere else later
// (for example to cloud storage) only means changing put and get here.
const fs = require('fs'), path = require('path');
const { encrypt, decrypt } = require('./util');

const localDir = () => path.join(process.env.AEGIS_DATA, 'documents');

// Stores the file encrypted and returns its stored_path.
async function put(tenantId, fileId, data) {
  const fp = path.join(localDir(), tenantId, `${fileId}.bin`);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, encrypt(data), { mode: 0o600 });
  return fp;
}
// Reads and decrypts a stored file.
async function get(storedPath) {
  return decrypt(fs.readFileSync(storedPath));
}

// Deletes a stored file. A file that is already gone is not an error.
async function remove(storedPath) {
  if (storedPath) fs.rmSync(storedPath, { force: true });
}

module.exports = { put, get, remove };
