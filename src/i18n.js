// Server messages. The UI has its own dictionary in public/i18n.js.
// To add a language: copy the "en" block, translate it and add the code to SUPPORTED.

export const SUPPORTED = ['en', 'pl'];

const messages = {
  en: {
    'auth.passwordTooShort': 'Password must be at least 10 characters long.',
    'auth.loginRequired': 'Please log in again.',
    'auth.badRequest': 'Invalid request.',
    'auth.rateLimited': 'Too many login attempts. Try again in a few minutes.',
    'setup.exists': 'The administrator account already exists.',
    'setup.badUsername': 'Username: 3–32 characters, letters, digits, ".", "_" or "-".',
    'login.invalid': 'Invalid username or password.',
    'password.wrongCurrent': 'Current password is incorrect.',
    'settings.badId': '{key} must be a number between 0 and 65535.',
    'settings.badPath': 'Invalid path: "{path}" (must be absolute and cannot be "/").',
    'notFound': 'Not found.',
    'delete.confirm': 'Type the stack name to confirm deletion.',
    'internal': 'Internal panel error – see the container logs for details.',

    'stack.badName': 'The name may only contain lowercase letters, digits, "-" and "_" (e.g. "nextcloud").',
    'stack.busy': 'Another operation is already running on this stack.',
    'stack.exists': 'A stack with this name already exists.',
    'stack.notFound': 'No such stack.',
    'compose.rejected': 'Docker rejected the compose file:\n{output}',
    'compose.configFailed': 'Could not read the configuration:\n{output}',
    'compose.yamlError': 'YAML syntax error: {message}',
    'compose.noServices': 'The compose file needs a "services" section with at least one service.',
    'action.unknown': 'Unknown action.',
    'step.exitCode': 'The command exited with code {code}.',
    'files.missing':
      'Missing configuration files that the app mounts as single files:\n{list}\n' +
      'Upload them to the stack folder and start again (Docker would create an empty folder in their place).',
    'remove.stopFailed': 'Could not stop the stack – nothing was deleted.',

    'log.pulling': 'Pulling image {image} to check where it stores data...',
    'log.created': '[volumes] created {path} (owner {owner})',
    'log.done': 'Done.',
    'log.error': 'Error: {message}',
    'log.movedToTrash': 'Stack folder moved to {path}',

    'change.rewrite': '{svc}: {from}  →  {to}',
    'change.image': '{svc}: image stores data in {target}  →  {entry}',
    'warn.variable': '{svc}: "{label}" contains a variable – left unchanged, make sure the data ends up in the stack folder.',
    'warn.external': '{svc}: volume "{name}" is external or uses its own driver – left unchanged and not covered by the folder backup.',
    'warn.allowlisted': '{svc}: "{source}" is on the allowed host paths list – kept, but not included in backups.',
    'warn.moveData': '{svc}: data from "{source}" is not copied automatically – if there was anything there, move it to {dest}.',
  },

  pl: {
    'auth.passwordTooShort': 'Hasło musi mieć co najmniej 10 znaków.',
    'auth.loginRequired': 'Zaloguj się ponownie.',
    'auth.badRequest': 'Nieprawidłowe żądanie.',
    'auth.rateLimited': 'Za dużo prób logowania. Spróbuj za kilka minut.',
    'setup.exists': 'Konto administratora już istnieje.',
    'setup.badUsername': 'Login: 3–32 znaki, litery, cyfry, ".", "_" lub "-".',
    'login.invalid': 'Nieprawidłowy login lub hasło.',
    'password.wrongCurrent': 'Obecne hasło jest nieprawidłowe.',
    'settings.badId': '{key} musi być liczbą 0–65535.',
    'settings.badPath': 'Nieprawidłowa ścieżka: "{path}" (musi być bezwzględna i nie może być "/").',
    'notFound': 'Nie znaleziono.',
    'delete.confirm': 'Wpisz nazwę stacka, aby potwierdzić usunięcie.',
    'internal': 'Wewnętrzny błąd panelu – szczegóły w logach kontenera.',

    'stack.badName': 'Nazwa może zawierać tylko małe litery, cyfry, "-" i "_" (np. "nextcloud").',
    'stack.busy': 'Na tym stacku trwa już inna operacja.',
    'stack.exists': 'Stack o tej nazwie już istnieje.',
    'stack.notFound': 'Nie ma takiego stacka.',
    'compose.rejected': 'Docker odrzucił plik compose:\n{output}',
    'compose.configFailed': 'Nie udało się odczytać konfiguracji:\n{output}',
    'compose.yamlError': 'Błąd składni YAML: {message}',
    'compose.noServices': 'Plik compose musi mieć sekcję "services" z co najmniej jedną usługą.',
    'action.unknown': 'Nieznana akcja.',
    'step.exitCode': 'Polecenie zakończyło się kodem {code}.',
    'files.missing':
      'Brakuje plików konfiguracyjnych, które aplikacja montuje jako pojedyncze pliki:\n{list}\n' +
      'Wgraj je do folderu stacka i uruchom ponownie (Docker utworzyłby w ich miejscu pusty folder).',
    'remove.stopFailed': 'Nie udało się zatrzymać stacka – nic nie usunięto.',

    'log.pulling': 'Pobieram obraz {image}, żeby sprawdzić, gdzie trzyma dane...',
    'log.created': '[wolumeny] utworzono {path} (właściciel {owner})',
    'log.done': 'Gotowe.',
    'log.error': 'Błąd: {message}',
    'log.movedToTrash': 'Folder stacka przeniesiono do {path}',

    'change.rewrite': '{svc}: {from}  →  {to}',
    'change.image': '{svc}: obraz przechowuje dane w {target}  →  {entry}',
    'warn.variable': '{svc}: "{label}" zawiera zmienną – zostawiam bez zmian, sprawdź czy dane trafią do folderu stacka.',
    'warn.external': '{svc}: wolumen "{name}" jest zewnętrzny lub ma własny driver – zostaje bez zmian i nie będzie w backupie folderu.',
    'warn.allowlisted': '{svc}: "{source}" jest na liście dozwolonych ścieżek hosta – zostaje, ale nie będzie w backupie.',
    'warn.moveData': '{svc}: dane z "{source}" nie są kopiowane automatycznie – jeśli coś tam było, przenieś je do {dest}.',
  },
};

export function translate(lang, key, vars = {}) {
  const dict = messages[lang] || messages.en;
  const template = dict[key] ?? messages.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_m, name) => (name in vars ? String(vars[name]) : `{${name}}`));
}

// Language from the X-Lang header (sent by the UI), then Accept-Language, English by default.
export function pickLang(req) {
  const explicit = String(req.get('X-Lang') || '').toLowerCase();
  if (SUPPORTED.includes(explicit)) return explicit;
  const accepted = String(req.get('Accept-Language') || '').toLowerCase();
  for (const part of accepted.split(',')) {
    const code = part.trim().slice(0, 2);
    if (SUPPORTED.includes(code)) return code;
  }
  return 'en';
}

export function i18nMiddleware(req, _res, next) {
  req.lang = pickLang(req);
  req.t = (key, vars) => translate(req.lang, key, vars);
  next();
}

// Turns a list of {key, vars} (changes/warnings from compose.js) into text.
export const translateAll = (t, list = []) => list.map((m) => (typeof m === 'string' ? m : t(m.key, m.vars)));
