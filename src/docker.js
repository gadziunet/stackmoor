import { spawn } from 'node:child_process';

const ENV = {
  ...process.env,
  COMPOSE_ANSI: 'never',
  DOCKER_CLI_HINTS: 'false',
  COMPOSE_STATUS_STDOUT: '1',
};

/**
 * Uruchamia polecenie `docker ...` bez powłoki (argumenty jako tablica,
 * więc nazwy stacków itp. nie mogą wstrzyknąć poleceń).
 */
export function docker(args, { cwd, onData, signal } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let output = '';
    const keep = (s) => {
      output += s;
      if (output.length > 400_000) output = output.slice(-200_000);
    };

    let child;
    try {
      child = spawn('docker', args, { cwd, env: ENV });
    } catch (err) {
      const msg = `docker: ${err.message}\n`;
      onData?.(msg);
      return resolve({ code: 127, stdout: '', output: msg });
    }

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      keep(s);
      onData?.(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      keep(s);
      onData?.(s);
    });

    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });

    child.on('error', (err) => {
      const msg = `docker: ${err.message}\n`;
      keep(msg);
      onData?.(msg);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      resolve({ code: code ?? 1, stdout, output });
    });
  });
}

// `docker compose ... --format json` zwraca albo tablicę, albo JSON w każdej linii.
export function parseJsonLines(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try { return JSON.parse(t); } catch { return []; }
  }
  return t.split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
