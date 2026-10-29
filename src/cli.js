// Small maintenance commands, run inside the container:
//   docker exec stackmoor node src/cli.js unlock   – allow opening the panel by IP again
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, saveSettings } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const [cmd] = process.argv.slice(2);

if (cmd === 'unlock') {
  const db = openDb(path.join(dataDir, 'panel.db'));
  saveSettings(db, { panelDomainOnly: false });
  console.log('The panel can be opened by IP address again.');
} else {
  console.log('Usage: node src/cli.js unlock');
  process.exit(cmd ? 1 : 0);
}
