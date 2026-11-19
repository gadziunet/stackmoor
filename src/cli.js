// Small maintenance commands, run inside the container:
//   docker exec stackmoor node src/cli.js unlock       – allow opening the panel by IP again
//   docker exec stackmoor node src/cli.js setup-code   – show the one-time setup code
//   docker exec stackmoor node src/cli.js setup-link http://192.168.1.10:5001
//                                                      – the address that fills the code in
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { openDb, saveSettings } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const [cmd] = process.argv.slice(2);

if (cmd === 'unlock') {
  const db = openDb(path.join(dataDir, 'panel.db'));
  saveSettings(db, { panelDomainOnly: false });
  console.log('The panel can be opened by IP address again.');
} else if (cmd === 'setup-code' || cmd === 'setup-link') {
  // Read-only: the panel creates the code on start and removes it once the account exists.
  let code = '';
  try { code = fs.readFileSync(path.join(dataDir, 'setup-token'), 'utf8').trim(); } catch { /* none */ }
  if (!code) {
    console.error('No setup code – the administrator account already exists.');
    process.exit(2);
  }
  if (cmd === 'setup-code') {
    console.log(code);
  } else {
    // The code goes after "#": the browser keeps it to itself (no server or proxy logs).
    const base = String(process.argv[3] || 'http://<server-address>:5001').replace(/[#?].*$/, '').replace(/\/+$/, '');
    console.log(`${base}/#setup=${code}`);
  }
} else {
  console.log('Usage: node src/cli.js unlock | setup-code | setup-link <panel address>');
  process.exit(cmd ? 1 : 0);
}
