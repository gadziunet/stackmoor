// Teksty interfejsu. Aby dodać język: skopiuj blok "en", przetłumacz i dodaj do LANGS.

export const LANGS = { en: 'English', pl: 'Polski' };

const dict = {
  en: {
    'auth.welcome': 'Welcome to StackPanel',
    'auth.login': 'Log in',
    'auth.setupLead': 'Create the administrator account. It will be the only account in the panel.',
    'auth.loginLead': 'Docker Compose stack manager.',
    'auth.username': 'Username',
    'auth.password': 'Password',
    'auth.minLength': 'At least 10 characters.',
    'auth.create': 'Create account',
    'auth.submit': 'Log in',

    'nav.newStack': '+ New stack',
    'nav.settings': 'Settings',
    'nav.logout': 'Log out',
    'nav.noStacks': 'No stacks yet.',

    'state.running': 'running',
    'state.partial': 'partially running',
    'state.exited': 'stopped',
    'state.down': 'not started',

    'home.title': 'Stacks',
    'home.emptyTitle': "You don't have any stacks yet",
    'home.emptyLead': "Paste a docker compose file from the app's docs – the panel takes care of the data folders.",
    'home.emptyCta': 'Create your first stack',

    'new.title': 'New stack',
    'new.name': 'Name',
    'new.namePlaceholder': 'e.g. nextcloud',
    'new.nameHint': 'Lowercase letters, digits, "-" and "_". Also used as the folder name.',
    'new.composeHint': 'No need to type data paths – <code>- /config</code> or nothing at all is enough, the panel creates folders in <code>./data/</code>.',
    'new.envOptional': '(optional)',
    'new.create': 'Create',
    'new.createStart': 'Create and start',

    'auto.label': 'Automatic volumes',
    'auto.hintNew': '– keep app data in the stack folder (recommended, needed for backups)',
    'auto.hint': '– keep app data in the stack folder',

    'notice.changes': 'The panel set up data storage for you:',
    'notice.warnings': 'Please check:',

    'stack.loading': 'Loading…',
    'act.up': 'Start',
    'act.restart': 'Restart',
    'act.update': 'Update',
    'act.updateTitle': 'Pull new images and restart',
    'act.stop': 'Stop',
    'act.down': 'Shut down',
    'act.downTitle': 'Stop and remove containers (data is kept)',
    'act.downConfirm': 'Shut down the stack and remove its containers? Data is kept.',
    'act.operation': 'Operation',
    'act.done': '{action} – done',
    'act.failed': '{action} – error',
    'toast.done': 'Done',
    'toast.failed': 'Operation finished with an error',

    'tab.compose': 'Compose',
    'tab.env': '.env',
    'tab.containers': 'Containers',
    'tab.logs': 'Logs',
    'tab.history': 'History',
    'tab.delete': 'Delete',

    'edit.save': 'Save',
    'edit.saveStart': 'Save and start',
    'edit.ctrlS': 'Ctrl+S saves',
    'edit.saved': 'Saved',
    'env.hint': 'Variables are available in compose as <code>${KEY}</code>. After changing them use “Start” so containers pick them up.',
    'env.saved': '.env saved',

    'ct.service': 'Service',
    'ct.state': 'State',
    'ct.image': 'Image',
    'ct.ports': 'Ports',
    'ct.empty': 'No containers – the stack has not been started yet or was shut down.',

    'logs.live': 'Live',
    'logs.refresh': 'Refresh',

    'hist.action': 'Action',
    'hist.result': 'Result',
    'hist.started': 'Started',
    'hist.show': 'Show',
    'hist.empty': 'No operations yet.',
    'hist.noOutput': '(no output)',

    'del.title': 'Delete stack',
    'del.lead': 'Containers will be stopped and removed. The stack folder with its data goes to the trash (<code>.trash/</code> in the stacks folder) – nothing is deleted permanently.',
    'del.confirm': 'Type <strong>{name}</strong> to confirm',
    'del.button': 'Delete stack',
    'del.done': 'Stack deleted',

    'set.title': 'Settings',
    'set.folders': 'Data folders',
    'set.foldersLead': 'Stacks live in <code>{dir}</code>, each app\'s data in <code>&lt;stack&gt;/data/</code>.',
    'set.puid': 'Owner (PUID)',
    'set.pgid': 'Group (PGID)',
    'set.allow': 'Host paths left unchanged (one per line)',
    'set.allowHint': 'E.g. media drives. Mounts under these paths are not moved and are not backed up.',
    'set.save': 'Save',
    'set.saved': 'Settings saved',
    'set.language': 'Language',
    'pw.title': 'Change password',
    'pw.current': 'Current password',
    'pw.new': 'New password',
    'pw.submit': 'Change password',
    'pw.done': 'Password changed',
  },

  pl: {
    'auth.welcome': 'Witaj w StackPanel',
    'auth.login': 'Zaloguj się',
    'auth.setupLead': 'Utwórz konto administratora. Będzie jedynym kontem w panelu.',
    'auth.loginLead': 'Panel zarządzania stackami Docker Compose.',
    'auth.username': 'Login',
    'auth.password': 'Hasło',
    'auth.minLength': 'Minimum 10 znaków.',
    'auth.create': 'Utwórz konto',
    'auth.submit': 'Zaloguj',

    'nav.newStack': '+ Nowy stack',
    'nav.settings': 'Ustawienia',
    'nav.logout': 'Wyloguj',
    'nav.noStacks': 'Brak stacków.',

    'state.running': 'działa',
    'state.partial': 'częściowo',
    'state.exited': 'zatrzymany',
    'state.down': 'nieuruchomiony',

    'home.title': 'Stacki',
    'home.emptyTitle': 'Nie masz jeszcze żadnego stacka',
    'home.emptyLead': 'Wklej docker compose z dokumentacji aplikacji – panel sam zadba o foldery na dane.',
    'home.emptyCta': 'Utwórz pierwszy stack',

    'new.title': 'Nowy stack',
    'new.name': 'Nazwa',
    'new.namePlaceholder': 'np. nextcloud',
    'new.nameHint': 'Małe litery, cyfry, „-” i „_”. Będzie też nazwą folderu.',
    'new.composeHint': 'Ścieżek na dane nie musisz wpisywać – wystarczy np. <code>- /config</code> albo nic, panel sam założy foldery w <code>./data/</code>.',
    'new.envOptional': '(opcjonalnie)',
    'new.create': 'Utwórz',
    'new.createStart': 'Utwórz i uruchom',

    'auto.label': 'Automatyczne wolumeny',
    'auto.hintNew': '– przepinaj dane do folderu stacka (zalecane, potrzebne do backupu)',
    'auto.hint': '– przepinaj dane do folderu stacka',

    'notice.changes': 'Panel sam ustawił miejsce na dane:',
    'notice.warnings': 'Do sprawdzenia:',

    'stack.loading': 'Wczytuję…',
    'act.up': 'Uruchom',
    'act.restart': 'Restart',
    'act.update': 'Aktualizuj',
    'act.updateTitle': 'Pobierz nowe obrazy i uruchom ponownie',
    'act.stop': 'Zatrzymaj',
    'act.down': 'Wyłącz',
    'act.downTitle': 'Zatrzymaj i usuń kontenery (dane zostają)',
    'act.downConfirm': 'Wyłączyć stack i usunąć kontenery? Dane zostają.',
    'act.operation': 'Operacja',
    'act.done': '{action} – gotowe',
    'act.failed': '{action} – błąd',
    'toast.done': 'Gotowe',
    'toast.failed': 'Operacja zakończona błędem',

    'tab.compose': 'Compose',
    'tab.env': '.env',
    'tab.containers': 'Kontenery',
    'tab.logs': 'Logi',
    'tab.history': 'Historia',
    'tab.delete': 'Usuń',

    'edit.save': 'Zapisz',
    'edit.saveStart': 'Zapisz i uruchom',
    'edit.ctrlS': 'Ctrl+S zapisuje',
    'edit.saved': 'Zapisano',
    'env.hint': 'Zmienne są dostępne w compose jako <code>${KLUCZ}</code>. Po zmianie użyj „Uruchom”, żeby kontenery je dostały.',
    'env.saved': 'Zapisano .env',

    'ct.service': 'Usługa',
    'ct.state': 'Stan',
    'ct.image': 'Obraz',
    'ct.ports': 'Porty',
    'ct.empty': 'Brak kontenerów – stack nie był jeszcze uruchomiony albo został wyłączony.',

    'logs.live': 'Na żywo',
    'logs.refresh': 'Odśwież',

    'hist.action': 'Akcja',
    'hist.result': 'Wynik',
    'hist.started': 'Start',
    'hist.show': 'Pokaż',
    'hist.empty': 'Brak operacji.',
    'hist.noOutput': '(brak wyjścia)',

    'del.title': 'Usuń stack',
    'del.lead': 'Kontenery zostaną zatrzymane i usunięte. Folder stacka razem z danymi trafi do kosza (<code>.trash/</code> w katalogu stacków) – nic nie jest kasowane na stałe.',
    'del.confirm': 'Wpisz <strong>{name}</strong>, aby potwierdzić',
    'del.button': 'Usuń stack',
    'del.done': 'Stack usunięty',

    'set.title': 'Ustawienia',
    'set.folders': 'Foldery na dane',
    'set.foldersLead': 'Stacki leżą w <code>{dir}</code>, dane każdej aplikacji w <code>&lt;stack&gt;/data/</code>.',
    'set.puid': 'Właściciel (PUID)',
    'set.pgid': 'Grupa (PGID)',
    'set.allow': 'Ścieżki hosta zostawiane bez zmian (jedna w linii)',
    'set.allowHint': 'Np. dyski z filmami. Montowania spod tych ścieżek nie są przepinane i nie będą w backupie.',
    'set.save': 'Zapisz',
    'set.saved': 'Zapisano ustawienia',
    'set.language': 'Język',
    'pw.title': 'Zmiana hasła',
    'pw.current': 'Obecne hasło',
    'pw.new': 'Nowe hasło',
    'pw.submit': 'Zmień hasło',
    'pw.done': 'Hasło zmienione',
  },
};

function detect() {
  try {
    const saved = localStorage.getItem('sp-lang');
    if (saved && dict[saved]) return saved;
  } catch { /* brak dostępu do localStorage */ }
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return dict[nav] ? nav : 'en';
}

export let lang = detect();

export function setLang(code) {
  if (!dict[code]) return;
  lang = code;
  document.documentElement.lang = code;
  try { localStorage.setItem('sp-lang', code); } catch { /* trudno */ }
}

// Wartości w {zmiennych} muszą być już bezpieczne dla HTML (używamy esc() przed przekazaniem).
export function t(key, vars = {}) {
  const template = dict[lang]?.[key] ?? dict.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_m, name) => (name in vars ? String(vars[name]) : `{${name}}`));
}

document.documentElement.lang = lang;
