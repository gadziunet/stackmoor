import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// Release builds get the version from the git tag (CI passes it as APP_VERSION),
// edge builds report "edge", local runs fall back to package.json.
export const VERSION =
  process.env.APP_VERSION && process.env.APP_VERSION !== 'dev' ? process.env.APP_VERSION : pkg.version;

export const REPO = process.env.MOORLINE_REPO || 'gadziunet/moorline';

const parse = (v) => {
  const m = String(v || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
};

export const isSemver = (v) => parse(v) !== null;

/** >0 when a is newer than b, <0 when older, 0 when equal; null if either is not a version. */
export function compareVersions(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // 1.0.0 is newer than 1.0.0-beta
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** The newest stable version from a list of tag names like "v0.1.2". */
export function newestTag(tags) {
  return tags
    .filter((t) => { const p = parse(t); return p && !p.pre; })
    .sort((a, b) => compareVersions(b, a))[0] || null;
}
