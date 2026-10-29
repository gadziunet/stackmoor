// StackPanel – interfejs (bez frameworka, bez kroku budowania).

const app = document.getElementById('app');
const state = { user: null, needsSetup: false, stacks: [], refreshTimer: null, abort: null };

const NEW_STACK_TEMPLATE = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - /usr/share/nginx/html
`;

const STATE_LABEL = { running: 'działa', partial: 'częściowo', exited: 'zatrzymany', down: 'nieuruchomiony' };

// ---------- pomocnicze ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'stackpanel' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user) {
    state.user = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || `Błąd ${res.status}`);
  return data;
}

// Czyta odpowiedź strumieniową i przekazuje tekst na bieżąco. Zwraca kod wyjścia (jeśli jest).
async function stream(method, url, onText, signal) {
  const res = await fetch(url, { method, headers: { 'X-Requested-With': 'stackpanel' }, signal });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Błąd ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let exit = null;
  let buf = '';
  // Wysyłamy na ekran tylko pełne linie, żeby znacznik __EXIT__ nigdy nie został przecięty.
  const flush = (all) => {
    const cut = all ? buf.length : buf.lastIndexOf('\n') + 1;
    if (cut <= 0) return;
    const out = buf.slice(0, cut).replace(/(^|\n)__EXIT__:(\d+)\n?/g, (_m, pre, code) => {
      exit = Number(code);
      return pre;
    });
    buf = buf.slice(cut);
    if (out) onText(out);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    flush(false);
  }
  buf += dec.decode();
  flush(true);
  return exit;
}

function stopStream() {
  state.abort?.abort();
  state.abort = null;
}

function appendTo(pre, text) {
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.textContent += text;
  if (pre.textContent.length > 300_000) pre.textContent = pre.textContent.slice(-200_000);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function enableTabKey(textarea, save) {
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = textarea;
      textarea.value = value.slice(0, s) + '  ' + value.slice(en);
      textarea.selectionStart = textarea.selectionEnd = s + 2;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save?.();
    }
  });
}

function notices(result) {
  let html = '';
  if (result.changes?.length) {
    html += `<div class="notice info"><strong>Panel sam ustawił miejsce na dane:</strong>
      <ul>${result.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`;
  }
  if (result.warnings?.length) {
    html += `<div class="notice warn"><strong>Do sprawdzenia:</strong>
      <ul>${result.warnings.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`;
  }
  return html;
}

// ---------- logowanie ----------

function renderAuth() {
  const setup = state.needsSetup;
  app.innerHTML = `
    <div class="auth"><form class="card" id="auth">
      <h1>${setup ? 'Witaj w StackPanel' : 'Zaloguj się'}</h1>
      <p>${setup ? 'Utwórz konto administratora. Będzie jedynym kontem w panelu.' : 'Panel zarządzania stackami Docker Compose.'}</p>
      <div class="field"><label for="u">Login</label>
        <input type="text" id="u" autocomplete="username" required value="${setup ? 'admin' : ''}"></div>
      <div class="field"><label for="p">Hasło</label>
        <input type="password" id="p" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 10 : 1}">
        ${setup ? '<p class="hint">Minimum 10 znaków.</p>' : ''}</div>
      <div id="err"></div>
      <button class="btn primary" style="width:100%">${setup ? 'Utwórz konto' : 'Zaloguj'}</button>
    </form></div>`;
  document.getElementById('auth').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { username: document.getElementById('u').value, password: document.getElementById('p').value };
    try {
      await api('POST', setup ? '/api/setup' : '/api/login', body);
      await boot();
    } catch (err) {
      document.getElementById('err').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
}

// ---------- układ ----------

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="6" width="24" height="6" rx="2" fill="#2f7d6d"/><rect x="4" y="14" width="24" height="6" rx="2" fill="#3f9b88"/><rect x="4" y="22" width="24" height="6" rx="2" fill="#67b8a6"/></svg>`;

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h === 'new') return { page: 'new' };
  if (h === 'settings') return { page: 'settings' };
  const m = h.match(/^stack\/([a-z0-9_-]+)$/);
  if (m) return { page: 'stack', name: m[1] };
  return { page: 'home' };
}

function renderShell() {
  if (!document.querySelector('.layout')) {
    app.innerHTML = `
      <div class="layout">
        <aside class="sidebar">
          <div class="brand">${LOGO}<span>StackPanel</span></div>
          <a class="btn primary new" href="#/new">+ Nowy stack</a>
          <ul class="stack-list" id="stack-list"></ul>
          <div class="sidebar-foot">
            <a class="btn small" href="#/settings">Ustawienia</a>
            <button class="btn small" id="logout">Wyloguj</button>
          </div>
        </aside>
        <main class="main" id="main"></main>
      </div>`;
    document.getElementById('logout').addEventListener('click', async () => {
      await api('POST', '/api/logout').catch(() => {});
      state.user = null;
      render();
    });
  }
  renderStackList();
}

function renderStackList() {
  const list = document.getElementById('stack-list');
  if (!list) return;
  const current = route().name;
  list.innerHTML = state.stacks.length
    ? state.stacks.map((s) => `
      <li><a href="#/stack/${esc(s.name)}" class="${s.name === current ? 'active' : ''}" title="${esc(STATE_LABEL[s.state])}">
        <span class="dot ${s.state}"></span>${esc(s.name)}
        <span class="count">${s.total ? `${s.running}/${s.total}` : ''}</span>
      </a></li>`).join('')
    : `<li class="empty-hint">Brak stacków.</li>`;
}

async function refreshStacks() {
  try {
    state.stacks = await api('GET', '/api/stacks');
    renderStackList();
    if (route().page === 'home') renderHome();
  } catch { /* np. wylogowanie */ }
}

// ---------- strony ----------

function renderHome() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="head"><h1>Stacki</h1></div>
    ${state.stacks.length ? `<div class="home-grid">${state.stacks.map((s) => `
      <a class="card" href="#/stack/${esc(s.name)}"><span class="dot ${s.state}"></span>
        <div><strong>${esc(s.name)}</strong><br><span class="hint">${esc(STATE_LABEL[s.state])}${s.total ? ` · ${s.running}/${s.total}` : ''}</span></div>
      </a>`).join('')}</div>`
    : `<div class="card"><h2>Nie masz jeszcze żadnego stacka</h2>
        <p class="hint">Wklej docker compose z dokumentacji aplikacji – panel sam zadba o foldery na dane.</p>
        <p><a class="btn primary" href="#/new">Utwórz pierwszy stack</a></p></div>`}`;
}

function renderNew() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="head"><h1>Nowy stack</h1></div>
    <form id="new" class="card">
      <div class="field"><label for="name">Nazwa</label>
        <input type="text" id="name" placeholder="np. nextcloud" required pattern="[a-z0-9][a-z0-9_\\-]*" autocapitalize="off" autocomplete="off">
        <p class="hint">Małe litery, cyfry, „-” i „_”. Będzie też nazwą folderu.</p></div>
      <div class="field"><label for="compose">compose.yaml</label>
        <textarea id="compose" class="code" spellcheck="false">${esc(NEW_STACK_TEMPLATE)}</textarea>
        <p class="hint">Ścieżek na dane nie musisz wpisywać – wystarczy np. <code>- /config</code> albo nic, panel sam założy foldery w <code>./data/</code>.</p></div>
      <div class="field"><label for="env">.env <span class="hint">(opcjonalnie)</span></label>
        <textarea id="env" class="code env" spellcheck="false" placeholder="TZ=Europe/Warsaw"></textarea></div>
      <label class="check field"><input type="checkbox" id="auto" checked>
        <span>Automatyczne wolumeny <span class="hint">– przepinaj dane do folderu stacka (zalecane, potrzebne do backupu)</span></span></label>
      <div id="out"></div>
      <div class="row">
        <button class="btn" type="submit" data-start="0">Utwórz</button>
        <button class="btn primary" type="submit" data-start="1">Utwórz i uruchom</button>
      </div>
    </form>`;
  enableTabKey(document.getElementById('compose'));
  document.getElementById('new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const start = e.submitter?.dataset.start === '1';
    const out = document.getElementById('out');
    const name = document.getElementById('name').value.trim();
    try {
      const res = await api('POST', '/api/stacks', {
        name,
        compose: document.getElementById('compose').value,
        env: document.getElementById('env').value,
        autoVolumes: document.getElementById('auto').checked,
      });
      sessionStorage.setItem(`sp-notice-${name}`, JSON.stringify(res));
      if (start) sessionStorage.setItem(`sp-autostart-${name}`, '1');
      await refreshStacks();
      location.hash = `#/stack/${name}`;
    } catch (err) {
      out.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
}

async function renderStack(name) {
  const main = document.getElementById('main');
  main.innerHTML = `<p class="hint">Wczytuję…</p>`;
  let data;
  try {
    data = await api('GET', `/api/stacks/${name}`);
  } catch (err) {
    main.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    return;
  }
  const summary = state.stacks.find((s) => s.name === name) || { state: 'down' };

  main.innerHTML = `
    <div class="head">
      <h1>${esc(name)}</h1>
      <span class="badge ${summary.state}" id="badge">${esc(STATE_LABEL[summary.state])}</span>
      <div class="actions">
        <button class="btn primary" data-act="up">Uruchom</button>
        <button class="btn" data-act="restart">Restart</button>
        <button class="btn" data-act="update" title="Pobierz nowe obrazy i uruchom ponownie">Aktualizuj</button>
        <button class="btn" data-act="stop">Zatrzymaj</button>
        <button class="btn" data-act="down" title="Zatrzymaj i usuń kontenery (dane zostają)">Wyłącz</button>
      </div>
    </div>
    <div id="notice"></div>
    <div id="op-wrap" hidden><h2 id="op-title">Operacja</h2><pre class="terminal" id="op"></pre><br></div>
    <div class="tabs" role="tablist">
      <button data-tab="compose" class="on">Compose</button>
      <button data-tab="env">.env</button>
      <button data-tab="containers">Kontenery</button>
      <button data-tab="logs">Logi</button>
      <button data-tab="history">Historia</button>
      <button data-tab="danger">Usuń</button>
    </div>
    <div id="tab"></div>`;

  const notice = document.getElementById('notice');
  const saved = sessionStorage.getItem(`sp-notice-${name}`);
  if (saved) {
    notice.innerHTML = notices(JSON.parse(saved));
    sessionStorage.removeItem(`sp-notice-${name}`);
  }

  let currentTab = 'compose';
  const tab = document.getElementById('tab');

  const tabs = {
    compose() {
      tab.innerHTML = `
        <div class="card">
          <textarea id="ed" class="code" spellcheck="false">${esc(data.compose)}</textarea>
          <label class="check" style="margin-top:12px"><input type="checkbox" id="auto" ${data.autoVolumes ? 'checked' : ''}>
            <span>Automatyczne wolumeny <span class="hint">– przepinaj dane do folderu stacka</span></span></label>
          <div id="save-out" style="margin-top:12px"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn" id="save">Zapisz</button>
            <button class="btn primary" id="save-up">Zapisz i uruchom</button>
            <span class="hint hide-mobile">Ctrl+S zapisuje</span>
          </div>
        </div>`;
      const ed = document.getElementById('ed');
      const doSave = async (thenUp) => {
        const out = document.getElementById('save-out');
        try {
          const res = await api('PUT', `/api/stacks/${name}`, {
            compose: ed.value, env: data.env, autoVolumes: document.getElementById('auto').checked,
          });
          data.compose = res.compose;
          data.autoVolumes = document.getElementById('auto').checked;
          ed.value = res.compose;
          out.innerHTML = notices(res);
          toast('Zapisano');
          if (thenUp) runAction('up');
        } catch (err) {
          out.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
        }
      };
      enableTabKey(ed, () => doSave(false));
      document.getElementById('save').addEventListener('click', () => doSave(false));
      document.getElementById('save-up').addEventListener('click', () => doSave(true));
    },

    env() {
      tab.innerHTML = `
        <div class="card">
          <textarea id="ed" class="code env" style="min-height:260px" spellcheck="false" placeholder="KLUCZ=wartość">${esc(data.env)}</textarea>
          <p class="hint">Zmienne są dostępne w compose jako <code>\${KLUCZ}</code>. Po zmianie użyj „Uruchom”, żeby kontenery je dostały.</p>
          <div id="save-out"></div>
          <button class="btn primary" id="save">Zapisz</button>
        </div>`;
      const ed = document.getElementById('ed');
      const doSave = async () => {
        const out = document.getElementById('save-out');
        try {
          await api('PUT', `/api/stacks/${name}`, { compose: data.compose, env: ed.value, autoVolumes: data.autoVolumes });
          data.env = ed.value;
          out.innerHTML = '';
          toast('Zapisano .env');
        } catch (err) {
          out.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
        }
      };
      enableTabKey(ed, doSave);
      document.getElementById('save').addEventListener('click', doSave);
    },

    async containers() {
      tab.innerHTML = `<p class="hint">Wczytuję…</p>`;
      const fresh = await api('GET', `/api/stacks/${name}`).catch(() => data);
      data.containers = fresh.containers;
      tab.innerHTML = data.containers.length ? `
        <div class="card" style="padding:6px 8px; overflow-x:auto"><table>
          <thead><tr><th>Usługa</th><th>Stan</th><th>Obraz</th><th>Porty</th></tr></thead>
          <tbody>${data.containers.map((c) => `
            <tr><td><strong>${esc(c.service)}</strong><br><span class="hint">${esc(c.name)}</span></td>
              <td><span class="badge ${c.state === 'running' ? 'running' : 'exited'}">${esc(c.state)}</span><br><span class="hint">${esc(c.status)}</span></td>
              <td><code>${esc(c.image)}</code></td>
              <td>${c.ports.map((p) => `<code>${esc(p)}</code>`).join('<br>') || '<span class="hint">—</span>'}</td></tr>`).join('')}
          </tbody></table></div>`
        : `<div class="card hint">Brak kontenerów – stack nie był jeszcze uruchomiony albo został wyłączony.</div>`;
    },

    logs() {
      tab.innerHTML = `
        <div class="row" style="margin-bottom:10px">
          <label class="check" style="margin:0"><input type="checkbox" id="follow" checked> Na żywo</label>
          <button class="btn small" id="reload">Odśwież</button>
        </div>
        <pre class="terminal tall" id="logs"></pre>`;
      const pre = document.getElementById('logs');
      const load = () => {
        stopStream();
        pre.textContent = '';
        const ctl = new AbortController();
        state.abort = ctl;
        const follow = document.getElementById('follow').checked ? 1 : 0;
        stream('GET', `/api/stacks/${name}/logs?tail=300&follow=${follow}`, (t) => appendTo(pre, t), ctl.signal)
          .catch((err) => { if (err.name !== 'AbortError') appendTo(pre, `\n${err.message}\n`); });
      };
      document.getElementById('reload').addEventListener('click', load);
      document.getElementById('follow').addEventListener('change', load);
      load();
    },

    async history() {
      const ops = await api('GET', `/api/stacks/${name}/operations`).catch(() => []);
      const LABEL = { up: 'Uruchom', restart: 'Restart', update: 'Aktualizuj', stop: 'Zatrzymaj', down: 'Wyłącz' };
      const STATUS = { ok: 'running', error: 'exited', running: 'partial', interrupted: 'exited' };
      tab.innerHTML = ops.length ? `
        <div class="card" style="padding:6px 8px"><table>
          <thead><tr><th>Akcja</th><th>Wynik</th><th>Start</th><th></th></tr></thead>
          <tbody>${ops.map((o) => `<tr>
            <td>${esc(LABEL[o.action] || o.action)}</td>
            <td><span class="badge ${STATUS[o.status] || ''}">${esc(o.status)}</span></td>
            <td><span class="hint">${esc(o.started_at)} UTC</span></td>
            <td><button class="btn small" data-op="${o.id}">Pokaż</button></td></tr>`).join('')}
          </tbody></table></div><pre class="terminal" id="op-out" hidden></pre>`
        : `<div class="card hint">Brak operacji.</div>`;
      tab.querySelectorAll('[data-op]').forEach((b) => b.addEventListener('click', async () => {
        const op = await api('GET', `/api/operations/${b.dataset.op}`);
        const pre = document.getElementById('op-out');
        pre.hidden = false;
        pre.textContent = op.output || '(brak wyjścia)';
        pre.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }));
    },

    danger() {
      tab.innerHTML = `
        <div class="card">
          <h2>Usuń stack</h2>
          <p class="hint">Kontenery zostaną zatrzymane i usunięte. Folder stacka razem z danymi trafi do kosza
            (<code>.trash/</code> w katalogu stacków) – nic nie jest kasowane na stałe.</p>
          <div class="field"><label for="confirm">Wpisz <strong>${esc(name)}</strong>, aby potwierdzić</label>
            <input type="text" id="confirm" autocomplete="off" autocapitalize="off"></div>
          <div id="del-out"></div>
          <button class="btn danger" id="del">Usuń stack</button>
        </div>`;
      document.getElementById('del').addEventListener('click', async () => {
        try {
          await api('DELETE', `/api/stacks/${name}`, { confirm: document.getElementById('confirm').value });
          toast('Stack usunięty');
          await refreshStacks();
          location.hash = '#/';
        } catch (err) {
          document.getElementById('del-out').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
        }
      });
    },
  };

  const showTab = (t) => {
    if (currentTab === 'logs' && t !== 'logs') stopStream();
    currentTab = t;
    main.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    tabs[t]();
  };
  main.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  async function runAction(act) {
    const buttons = main.querySelectorAll('[data-act]');
    buttons.forEach((b) => (b.disabled = true));
    const wrap = document.getElementById('op-wrap');
    const pre = document.getElementById('op');
    const title = main.querySelector(`[data-act="${act}"]`)?.textContent || act;
    document.getElementById('op-title').textContent = `${title}…`;
    wrap.hidden = false;
    pre.textContent = '';
    try {
      const code = await stream('POST', `/api/stacks/${name}/actions/${act}`, (t) => appendTo(pre, t));
      document.getElementById('op-title').textContent = code === 0 ? `${title} – gotowe` : `${title} – błąd`;
      toast(code === 0 ? 'Gotowe' : 'Operacja zakończona błędem');
    } catch (err) {
      appendTo(pre, `\n${err.message}\n`);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      await refreshStacks();
      const s = state.stacks.find((x) => x.name === name);
      const badge = document.getElementById('badge');
      if (s && badge) {
        badge.className = `badge ${s.state}`;
        badge.textContent = STATE_LABEL[s.state];
      }
      // compose.yaml mógł zostać uzupełniony o wolumeny z obrazu
      const fresh = await api('GET', `/api/stacks/${name}`).catch(() => null);
      if (fresh) {
        data.compose = fresh.compose;
        data.containers = fresh.containers;
        if (currentTab === 'compose' || currentTab === 'containers') tabs[currentTab]();
      }
    }
  }
  main.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.act === 'down' && !confirm('Wyłączyć stack i usunąć kontenery? Dane zostają.')) return;
    runAction(b.dataset.act);
  }));

  tabs.compose();
  if (sessionStorage.getItem(`sp-autostart-${name}`)) {
    sessionStorage.removeItem(`sp-autostart-${name}`);
    runAction('up');
  }
}

async function renderSettings() {
  const main = document.getElementById('main');
  const s = await api('GET', '/api/settings');
  main.innerHTML = `
    <div class="head"><h1>Ustawienia</h1></div>
    <form class="card" id="settings">
      <h2>Foldery na dane</h2>
      <p class="hint" style="margin-top:-4px">Stacki leżą w <code>${esc(s.stacksDir)}</code>, dane każdej aplikacji w <code>&lt;stack&gt;/data/</code>.</p>
      <div class="row field">
        <div style="flex:1;min-width:120px"><label for="puid">Właściciel (PUID)</label><input type="number" id="puid" value="${esc(s.puid)}"></div>
        <div style="flex:1;min-width:120px"><label for="pgid">Grupa (PGID)</label><input type="number" id="pgid" value="${esc(s.pgid)}"></div>
      </div>
      <div class="field"><label for="allow">Ścieżki hosta zostawiane bez zmian (jedna w linii)</label>
        <textarea id="allow" class="code env" spellcheck="false">${esc(s.hostPathAllowlist.join('\n'))}</textarea>
        <p class="hint">Np. dyski z filmami. Montowania spod tych ścieżek nie są przepinane i nie będą w backupie.</p></div>
      <div id="s-out"></div>
      <button class="btn primary">Zapisz</button>
    </form>
    <form class="card" id="pw">
      <h2>Zmiana hasła</h2>
      <div class="field"><label for="cur">Obecne hasło</label><input type="password" id="cur" autocomplete="current-password" required></div>
      <div class="field"><label for="nw">Nowe hasło</label><input type="password" id="nw" autocomplete="new-password" minlength="10" required></div>
      <div id="pw-out"></div>
      <button class="btn">Zmień hasło</button>
    </form>`;
  document.getElementById('settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', {
        puid: Number(document.getElementById('puid').value),
        pgid: Number(document.getElementById('pgid').value),
        hostPathAllowlist: document.getElementById('allow').value.split('\n'),
      });
      document.getElementById('s-out').innerHTML = '';
      toast('Zapisano ustawienia');
    } catch (err) {
      document.getElementById('s-out').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
  document.getElementById('pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/password', { current: document.getElementById('cur').value, next: document.getElementById('nw').value });
      e.target.reset();
      document.getElementById('pw-out').innerHTML = '';
      toast('Hasło zmienione');
    } catch (err) {
      document.getElementById('pw-out').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
}

// ---------- start ----------

function render() {
  stopStream();
  if (!state.user) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    return renderAuth();
  }
  renderShell();
  const r = route();
  if (r.page === 'new') renderNew();
  else if (r.page === 'settings') renderSettings();
  else if (r.page === 'stack') renderStack(r.name);
  else renderHome();
}

async function boot() {
  const s = await api('GET', '/api/state');
  state.user = s.user;
  state.needsSetup = s.needsSetup;
  if (state.user) {
    state.stacks = await api('GET', '/api/stacks').catch(() => []);
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(refreshStacks, 10_000);
  }
  render();
}

window.addEventListener('hashchange', render);
boot();
