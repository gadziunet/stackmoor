import fs from 'node:fs';

// Inside a container the stacks folder must be bind-mounted from the host at the same path.
// If it isn't, stacks live in the container's own filesystem: they vanish on update and
// the host's Docker daemon cannot see their files. Detect that so the UI can warn.

const decode = (s) => s.replace(/\\(\d{3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));

/** Mount points from /proc/self/mountinfo (5th field). */
export function mountPoints(mountinfo) {
  return String(mountinfo || '')
    .split('\n')
    .map((line) => line.split(' ')[4])
    .filter(Boolean)
    .map(decode);
}

/** The mount that holds `dir`: the longest mount point that is `dir` or one of its parents. */
export function mountFor(dir, points) {
  let best = '/';
  for (const p of points) {
    if ((dir === p || dir.startsWith(p.endsWith('/') ? p : p + '/')) && p.length > best.length) best = p;
  }
  return best;
}

export function isInContainer() {
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

/** true when OK (not in a container, or the folder sits on its own mount). */
export function stacksDirMounted(dir) {
  if (!isInContainer()) return true;
  try {
    return mountFor(dir, mountPoints(fs.readFileSync('/proc/self/mountinfo', 'utf8'))) !== '/';
  } catch {
    return true; // can't tell – don't raise a false alarm
  }
}
