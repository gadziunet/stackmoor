// Stackmoor UI – no framework, no build step.
import { t, lang, setLang, LANGS } from './i18n.js';

const app = document.getElementById('app');
const state = { user: null, needsSetup: false, stacks: [], refreshTimer: null, abort: null, version: '' };

const NEW_STACK_TEMPLATE = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - /usr/share/nginx/html
`;

const stateLabel = (s) => t(`state.${s}`);

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

const headers = (json) => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  'X-Requested-With': 'stackmoor',
  'X-Lang': lang,
});

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: headers(true),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user) {
    state.user = null;
    render();
  }
  // The panel was locked to its domain while this tab used the IP address.
  if (res.status === 421 && data.redirect) location.href = data.redirect + location.hash;
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Reads a streamed response and passes text through as it arrives. Returns the exit code (if any).
async function stream(method, url, onText, signal) {
  const res = await fetch(url, { method, headers: headers(false), signal });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let exit = null;
  let buf = '';
  // Only full lines are shown, so the __EXIT__ marker is never split.
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

const errorBox = (err) => `<div class="notice error">${esc(err.message)}</div>`;

function notices(result) {
  let html = '';
  if (result.changes?.length) {
    html += `<div class="notice info"><strong>${t('notice.changes')}</strong>
      <ul>${result.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`;
  }
  if (result.warnings?.length) {
    html += `<div class="notice warn"><strong>${t('notice.warnings')}</strong>
      <ul>${result.warnings.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`;
  }
  return html;
}

function langSelect(id) {
  return `<select id="${id}" class="lang" aria-label="${esc(t('set.language'))}">
    ${Object.entries(LANGS).map(([code, label]) => `<option value="${code}" ${code === lang ? 'selected' : ''}>${label}</option>`).join('')}
  </select>`;
}

function bindLangSelect(id) {
  document.getElementById(id)?.addEventListener('change', (e) => {
    setLang(e.target.value);
    document.querySelector('.layout')?.remove(); // rebuild the whole layout in the new language
    render();
  });
}

// ---------- login ----------

function renderAuth() {
  if (state.wizard === 'progress') return renderRestoreProgress();
  if (state.wizard === 'restore' && state.needsSetup) return renderRestoreWizard();
  const setup = state.needsSetup;
  app.innerHTML = `
    <div class="auth"><form class="card" id="auth">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <img src="/logo.svg" alt="Stackmoor" width="52" height="52">${langSelect('auth-lang')}
      </div>
      <h1>${t(setup ? 'auth.welcome' : 'auth.login')}</h1>
      <p>${t(setup ? 'auth.setupLead' : 'auth.loginLead')}</p>
      <div class="field"><label for="u">${t('auth.username')}</label>
        <input type="text" id="u" autocomplete="username" autocapitalize="off" required value="${setup ? 'admin' : ''}"></div>
      <div class="field"><label for="p">${t('auth.password')}</label>
        <input type="password" id="p" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 10 : 1}">
        ${setup ? `<p class="hint">${t('auth.minLength')}</p>` : ''}</div>
      <div id="err"></div>
      <button class="btn primary" style="width:100%">${t(setup ? 'auth.create' : 'auth.submit')}</button>
      ${setup ? `<p class="auth-or">${t('wiz.or')}</p>
        <button type="button" class="btn" id="wiz-open" style="width:100%">${t('wiz.restoreBtn')}</button>` : ''}
    </form></div>`;
  bindLangSelect('auth-lang');
  document.getElementById('wiz-open')?.addEventListener('click', () => { state.wizard = 'restore'; render(); });
  document.getElementById('auth').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { username: document.getElementById('u').value, password: document.getElementById('p').value };
    try {
      await api('POST', setup ? '/api/setup' : '/api/login', body);
      await boot();
    } catch (err) {
      document.getElementById('err').innerHTML = errorBox(err);
    }
  });
}

// ---------- setup wizard: restore a whole server ----------

async function renderRestoreWizard() {
  let opts;
  try {
    opts = await api('GET', '/api/setup/restore/options');
  } catch (err) {
    state.wizard = null;
    return render();
  }
  const dests = opts.destinations;
  app.innerHTML = `
    <div class="auth"><div class="card wide">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <img src="/logo.svg" alt="Stackmoor" width="52" height="52">${langSelect('auth-lang')}
      </div>
      <h1>${t('wiz.title')}</h1>
      <p>${t('wiz.lead')}</p>
      <form id="wiz-form">
        <div class="field"><label for="wz-dest">${t('bak.destination')}</label>
          <select id="wz-dest" class="lang">${dests.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></div>
        <div class="row field">
          <div style="flex:3;min-width:200px"><label for="wz-endpoint">${t('bak.endpoint')}</label>
            <input type="text" id="wz-endpoint" autocapitalize="off" autocomplete="off" required></div>
          <div style="flex:1;min-width:110px"><label for="wz-region">${t('bak.region')}</label>
            <input type="text" id="wz-region" autocapitalize="off" autocomplete="off"></div>
        </div>
        <div class="row field">
          <div style="flex:2;min-width:160px"><label for="wz-bucket">${t('bak.bucket')}</label>
            <input type="text" id="wz-bucket" autocapitalize="off" autocomplete="off" required></div>
          <div style="flex:1;min-width:110px"><label for="wz-prefix">${t('bak.prefix')}</label>
            <input type="text" id="wz-prefix" value="stackmoor" autocapitalize="off" autocomplete="off"></div>
        </div>
        <div class="field"><label for="wz-ak">${t('bak.accessKey')}</label>
          <input type="text" id="wz-ak" autocapitalize="off" autocomplete="off" required></div>
        <div class="field"><label for="wz-sk">${t('bak.secretKey')}</label>
          <input type="password" id="wz-sk" autocomplete="off" required></div>
        <div class="field"><label for="wz-pw">${t('bak.password')}</label>
          <input type="password" id="wz-pw" autocomplete="off" required></div>
        <div id="wz-out"></div>
        <div class="row">
          <button class="btn primary" id="wz-connect">${t('wiz.connect')}</button>
          <button type="button" class="btn" id="wz-back">${t('wiz.back')}</button>
        </div>
      </form>
      <div id="wz-runs"></div>
    </div></div>`;
  bindLangSelect('auth-lang');
  const fill = () => {
    const d = dests.find((x) => x.id === document.getElementById('wz-dest').value);
    const region = d?.region || '';
    document.getElementById('wz-region').value = region;
    document.getElementById('wz-endpoint').value = d?.endpoint && !d.endpoint.includes('<') ? d.endpoint.replace('{region}', region) : '';
    document.getElementById('wz-endpoint').placeholder = (d?.endpoint || 'minio.example.com:9000').replace('{region}', region || 'region');
  };
  fill();
  document.getElementById('wz-dest').addEventListener('change', fill);
  document.getElementById('wz-region').addEventListener('input', (e) => {
    const d = dests.find((x) => x.id === document.getElementById('wz-dest').value);
    if (d?.endpoint && d.endpoint.includes('{region}') && !d.endpoint.includes('<')) {
      document.getElementById('wz-endpoint').value = d.endpoint.replace('{region}', e.target.value.trim());
    }
  });
  document.getElementById('wz-back').addEventListener('click', () => { state.wizard = null; render(); });

  document.getElementById('wiz-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('wz-out');
    const btn = document.getElementById('wz-connect');
    const val = (id) => document.getElementById(id).value.trim();
    btn.disabled = true;
    out.innerHTML = `<p class="hint">${t('wiz.connecting')}</p>`;
    let runs;
    try {
      ({ runs } = await api('POST', '/api/setup/restore/connect', {
        destination: val('wz-dest'), endpoint: val('wz-endpoint'), region: val('wz-region'), bucket: val('wz-bucket'),
        prefix: val('wz-prefix'), accessKey: val('wz-ak'), secretKey: val('wz-sk'), password: document.getElementById('wz-pw').value,
      }));
    } catch (err) {
      out.innerHTML = errorBox(err);
      btn.disabled = false;
      return;
    }
    out.innerHTML = '';
    btn.disabled = false;
    const box = document.getElementById('wz-runs');
    if (!runs.length) {
      box.innerHTML = `<div class="notice warn">${t('wiz.noRuns')}</div>`;
      return;
    }
    box.innerHTML = `
      <h2 style="margin-top:22px">${t('wiz.chooseRun')}</h2>
      <form id="wz-pick">
        <div class="run-pick">${runs.map((r, i) => `
          <label class="check run-option"><input type="radio" name="run" value="${esc(r.id)}" ${i === 0 ? 'checked' : ''}>
            <span><strong>${fmtDate(r.time)}</strong> · ${esc(t(`bak.kind.${r.kind}`))} · ${fmtBytes(r.size)}<br>
            <span class="hint">${r.stacks.length ? esc(r.stacks.join(', ')) : t('wiz.noStacks')}</span></span></label>`).join('')}
        </div>
        <p class="hint">${t('wiz.startWarn')}</p>
        <div id="wz-start-out"></div>
        <button class="btn primary">${t('wiz.start')}</button>
      </form>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('wz-pick').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const run = document.querySelector('input[name="run"]:checked')?.value;
      try {
        await api('POST', '/api/setup/restore/start', { run });
      } catch (err) {
        document.getElementById('wz-start-out').innerHTML = errorBox(err);
        return;
      }
      state.wizard = 'progress';
      render();
    });
  });
}

function renderRestoreProgress() {
  app.innerHTML = `
    <div class="auth"><div class="card wide">
      <img src="/logo.svg" alt="Stackmoor" width="52" height="52">
      <h1 id="wz-title">${t('wiz.progress')}</h1>
      <p id="wz-phase">${t('stack.loading')}</p>
      <div class="progress" aria-hidden="true"><span id="wz-bar"></span></div>
      <pre class="terminal" id="wz-log"></pre>
      <div id="wz-done"></div>
    </div></div>`;
  const pre = document.getElementById('wz-log');
  const tick = async () => {
    if (state.wizard !== 'progress') return;
    let st;
    try {
      st = await api('GET', '/api/setup/restore/status');
    } catch {
      return setTimeout(tick, 3000);
    }
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = st.log || '';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
    const phase = document.getElementById('wz-phase');
    phase.textContent = st.phase === 'stacks'
      ? t('wiz.phase.stacks', { i: st.current, n: st.total, name: st.stack || '' })
      : t(`wiz.phase.${st.phase}`);
    const parts = 2 + st.total;
    const doneParts = st.phase === 'panel' ? 0 : st.phase === 'stacks' ? Math.max(0, st.current) : parts;
    document.getElementById('wz-bar').style.width = `${Math.round((doneParts / parts) * 100)}%`;
    if (!st.done) return setTimeout(tick, 2000);

    document.getElementById('wz-title').textContent = t(st.error ? 'wiz.stopped' : 'wiz.finished');
    const msg = st.error
      ? `<div class="notice error">${esc(t('wiz.error', { error: st.error }))}</div>`
      : st.failed.length
        ? `<div class="notice warn">${esc(t('wiz.doneFailed', { list: st.failed.join(', ') }))}</div>`
        : `<div class="notice info">${t('wiz.done')}</div>`;
    document.getElementById('wz-done').innerHTML = `${msg}
      <button class="btn primary" id="wz-login" style="width:100%">${t(st.error ? 'wiz.back' : 'wiz.login')}</button>`;
    document.getElementById('wz-login').addEventListener('click', async () => {
      state.wizard = null;
      await boot();
    });
  };
  tick();
}

// ---------- layout ----------

const LOGO = `<img src="/logo.svg" alt="" width="28" height="28">`;

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h === 'new') return { page: 'new' };
  const st = h.match(/^settings(?:\/([a-z]+))?$/);
  if (st) return { page: 'settings', tab: st[1] || 'general' };
  const m = h.match(/^stack\/([a-z0-9_-]+)$/);
  if (m) return { page: 'stack', name: m[1] };
  return { page: 'home' };
}

function renderShell() {
  if (!document.querySelector('.layout')) {
    app.innerHTML = `
      <div class="layout">
        <aside class="sidebar">
          <a class="brand" href="#/" title="${esc(t('home.title'))}">${LOGO}<span>Stackmoor</span></a><span class="version">${esc(state.version)}</span>
          <a class="update-pill" id="panel-update" href="#/settings/updates" hidden></a>
          <a class="btn primary new" href="#/new"><span class="lbl-long">${t('nav.newStack')}</span><span class="lbl-short">${t('nav.newShort')}</span></a>
          <ul class="stack-list" id="stack-list"></ul>
          <div class="sidebar-foot">
            <a class="btn small" href="#/settings">${t('nav.settings')}</a>
            <button class="btn small" id="logout">${t('nav.logout')}</button>
          </div>
        </aside>
        <div class="main-wrap"><div id="global-warning"></div><main class="main" id="main"></main></div>
        <nav class="bottom-nav" aria-label="Stackmoor">
          <a href="#/" data-nav="home">${t('home.title')}</a>
          <a href="#/settings" data-nav="settings">${t('nav.settings')}</a>
        </nav>
      </div>`;
    document.getElementById('logout').addEventListener('click', async () => {
      await api('POST', '/api/logout').catch(() => {});
      state.user = null;
      render();
    });
  }
  renderStackList();
  renderUpdateBadge();
  const warn = document.getElementById('global-warning');
  if (warn) {
    warn.innerHTML = (state.stacksDirOk === false
      ? `<div class="notice error global">${t('warn.stacksDir', { dir: esc(state.stacksDir) })}</div>`
      : '')
      + (state.updating ? `<div class="notice info global">${t('upd.restarting')}</div>` : '');
  }
}

function renderStackList() {
  const list = document.getElementById('stack-list');
  if (!list) return;
  const current = route().name;
  list.innerHTML = state.stacks.length
    ? state.stacks.map((s) => `
      <li><a href="#/stack/${esc(s.name)}" class="${s.name === current ? 'active' : ''}" title="${esc(stateLabel(s.state))}">
        <span class="dot ${s.state}"></span>${esc(s.name)}
        ${s.updateAvailable ? `<span class="upd" title="${esc(t('upd.stackBadge'))}" aria-label="${esc(t('upd.stackBadge'))}">↑</span>` : ''}
        <span class="count">${s.total ? `${s.running}/${s.total}` : ''}</span>
      </a></li>`).join('')
    : `<li class="empty-hint">${t('nav.noStacks')}</li>`;
}

async function refreshStacks() {
  try {
    state.stacks = await api('GET', '/api/stacks');
    renderStackList();
    if (route().page === 'home') renderHome();
  } catch { /* e.g. logged out */ }
}

// ---------- pages ----------

function renderHome() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="head"><h1>${t('home.title')}</h1></div>
    ${state.stacks.length ? `<div class="home-grid">${state.stacks.map((s) => `
      <a class="card" href="#/stack/${esc(s.name)}"><span class="dot ${s.state}"></span>
        <div><strong>${esc(s.name)}</strong><br><span class="hint">${esc(stateLabel(s.state))}${s.total ? ` · ${s.running}/${s.total}` : ''}${s.updateAvailable ? ` · ${t('upd.stackBadge')}` : ''}</span></div>
      </a>`).join('')}</div>`
    : `<div class="card"><h2>${t('home.emptyTitle')}</h2>
        <p class="hint">${t('home.emptyLead')}</p>
        <p><a class="btn primary" href="#/new">${t('home.emptyCta')}</a></p></div>`}`;
}

function renderNew() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="head"><h1>${t('new.title')}</h1></div>
    <form id="new" class="card">
      <div class="field"><label for="name">${t('new.name')}</label>
        <input type="text" id="name" placeholder="${esc(t('new.namePlaceholder'))}" required pattern="[a-z0-9][a-z0-9_\\-]*" autocapitalize="off" autocomplete="off">
        <p class="hint">${t('new.nameHint')}</p></div>
      <div class="field"><label for="compose">compose.yaml</label>
        <textarea id="compose" class="code" spellcheck="false">${esc(NEW_STACK_TEMPLATE)}</textarea>
        <p class="hint">${t('new.composeHint')}</p></div>
      <div class="field"><label for="env">.env <span class="hint">${t('new.envOptional')}</span></label>
        <textarea id="env" class="code env" spellcheck="false" placeholder="TZ=Europe/Warsaw"></textarea></div>
      <label class="check field"><input type="checkbox" id="auto" checked>
        <span>${t('auto.label')} <span class="hint">${t('auto.hintNew')}</span></span></label>
      <div id="out"></div>
      <div class="row">
        <button class="btn" type="submit" data-start="0">${t('new.create')}</button>
        <button class="btn primary" type="submit" data-start="1">${t('new.createStart')}</button>
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
      state.pendingNotice = { name, result: res, autostart: start };
      await refreshStacks();
      location.hash = `#/stack/${name}`;
    } catch (err) {
      out.innerHTML = errorBox(err);
    }
  });
}

/**
 * Addresses where a stack's app can be opened: its domains when it has any,
 * otherwise the published TCP ports on the address the panel is opened from.
 */
function openTargets(routesInfo, containers) {
  if (routesInfo?.domain && routesInfo.routes?.length) {
    return [...new Set(routesInfo.routes.map((r) => `https://${r.subdomain}.${routesInfo.domain}`))];
  }
  const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
  const urls = [];
  for (const c of containers || []) {
    for (const p of c.ports || []) {
      const m = /^(\d+)→(\d+)\/tcp$/.exec(p);
      if (!m) continue;
      const scheme = m[2] === '443' ? 'https' : 'http';
      urls.push(`${scheme}://${host}:${m[1]}`);
    }
  }
  return [...new Set(urls)];
}

// Close an open "Open" menu when clicking anywhere else.
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.open-menu[open]').forEach((d) => { if (!d.contains(e.target) || e.target.closest('.menu a')) d.open = false; });
});

/** The "Open" button next to Start/Restart…: one link, or a small menu when there are several. */
async function fillOpenButton(name, containers) {
  const info = await api('GET', `/api/stacks/${name}/routes`).catch(() => null);
  const slot = document.getElementById('open-slot');
  if (!slot) return;
  const urls = openTargets(info, containers);
  const label = (u) => esc(u.replace(/^https?:\/\//, ''));
  if (!urls.length) slot.innerHTML = '';
  else if (urls.length === 1) {
    slot.innerHTML = `<a class="btn" href="${esc(urls[0])}" target="_blank" rel="noopener" title="${esc(urls[0])}">${t('act.open')} ↗</a>`;
  } else {
    slot.innerHTML = `<details class="open-menu"><summary class="btn">${t('act.open')} ▾</summary>
      <div class="menu">${urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${label(u)} ↗</a>`).join('')}</div></details>`;
  }
}

async function renderStack(name) {
  const main = document.getElementById('main');
  main.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
  let data;
  try {
    data = await api('GET', `/api/stacks/${name}`);
  } catch (err) {
    main.innerHTML = errorBox(err);
    return;
  }
  const summary = state.stacks.find((s) => s.name === name) || { state: 'down' };

  main.innerHTML = `
    <div class="head">
      <h1>${esc(name)}</h1>
      <span class="badge ${summary.state}" id="badge">${esc(stateLabel(summary.state))}</span>
      <div class="actions">
        <button class="btn primary" data-act="up">${t('act.up')}</button>
        <button class="btn" data-act="restart">${t('act.restart')}</button>
        <button class="btn" data-act="update" title="${esc(t('act.updateTitle'))}">${t('act.update')}</button>
        <button class="btn" data-act="stop">${t('act.stop')}</button>
        <button class="btn" data-act="down" title="${esc(t('act.downTitle'))}">${t('act.down')}</button>
        <span id="open-slot"></span>
      </div>
    </div>
    <div id="notice"></div>
    <div id="op-wrap" hidden><h2 id="op-title">${t('act.operation')}</h2><pre class="terminal" id="op"></pre><br></div>
    <div class="tabs" role="tablist">
      ${['compose', 'env', 'domain', 'containers', 'logs', 'backups', 'history', 'delete']
        .map((k, i) => `<button data-tab="${k}" class="${i === 0 ? 'on' : ''}">${t(`tab.${k}`)}</button>`).join('')}
    </div>
    <div id="tab"></div>`;

  fillOpenButton(name, data.containers);

  let autostart = false;
  if (state.pendingNotice?.name === name) {
    document.getElementById('notice').innerHTML = notices(state.pendingNotice.result);
    autostart = state.pendingNotice.autostart;
    state.pendingNotice = null;
  }
  const newImages = (state.updates?.stacks?.[name]?.images || []).filter((i) => i.updateAvailable);
  if (summary.updateAvailable && newImages.length) {
    document.getElementById('notice').insertAdjacentHTML('beforeend', `
      <div class="notice info" id="stack-upd-box"><strong>${t('upd.stackTitle')}</strong>
        <ul>${newImages.map((i) => `<li>${esc(i.svc)}: ${esc(i.image)}</li>`).join('')}</ul>
        <p class="hint" style="margin:8px 0">${t('upd.stackLead')}</p>
        <button class="btn primary small" id="stack-upd">${t('act.update')}</button>
      </div>`);
  }

  let currentTab = 'compose';
  const tab = document.getElementById('tab');

  const tabs = {
    compose() {
      tab.innerHTML = `
        <div class="card">
          <textarea id="ed" class="code" spellcheck="false">${esc(data.compose)}</textarea>
          <label class="check" style="margin-top:12px"><input type="checkbox" id="auto" ${data.autoVolumes ? 'checked' : ''}>
            <span>${t('auto.label')} <span class="hint">${t('auto.hint')}</span></span></label>
          <div id="save-out" style="margin-top:12px"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn" id="save">${t('edit.save')}</button>
            <button class="btn primary" id="save-up">${t('edit.saveStart')}</button>
            <span class="hint hide-mobile">${t('edit.ctrlS')}</span>
          </div>
        </div>`;
      const ed = document.getElementById('ed');
      const doSave = async (thenUp) => {
        const out = document.getElementById('save-out');
        const auto = document.getElementById('auto').checked;
        try {
          const res = await api('PUT', `/api/stacks/${name}`, { compose: ed.value, env: data.env, autoVolumes: auto });
          data.compose = res.compose;
          data.autoVolumes = auto;
          ed.value = res.compose;
          out.innerHTML = notices(res);
          toast(t('edit.saved'));
          if (thenUp) runAction('up');
        } catch (err) {
          out.innerHTML = errorBox(err);
        }
      };
      enableTabKey(ed, () => doSave(false));
      document.getElementById('save').addEventListener('click', () => doSave(false));
      document.getElementById('save-up').addEventListener('click', () => doSave(true));
    },

    env() {
      tab.innerHTML = `
        <div class="card">
          <textarea id="ed" class="code env" style="min-height:260px" spellcheck="false" placeholder="KEY=value">${esc(data.env)}</textarea>
          <p class="hint">${t('env.hint')}</p>
          <div id="save-out"></div>
          <button class="btn primary" id="save">${t('edit.save')}</button>
        </div>`;
      const ed = document.getElementById('ed');
      const doSave = async () => {
        const out = document.getElementById('save-out');
        try {
          await api('PUT', `/api/stacks/${name}`, { compose: data.compose, env: ed.value, autoVolumes: data.autoVolumes });
          data.env = ed.value;
          out.innerHTML = '';
          toast(t('env.saved'));
        } catch (err) {
          out.innerHTML = errorBox(err);
        }
      };
      enableTabKey(ed, doSave);
      document.getElementById('save').addEventListener('click', doSave);
    },

    async containers() {
      tab.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
      const fresh = await api('GET', `/api/stacks/${name}`).catch(() => data);
      data.containers = fresh.containers;
      if (currentTab !== 'containers') return;
      tab.innerHTML = data.containers.length ? `
        <div class="card" style="padding:6px 8px; overflow-x:auto"><table>
          <thead><tr><th>${t('ct.service')}</th><th>${t('ct.state')}</th><th>${t('ct.image')}</th><th>${t('ct.ports')}</th></tr></thead>
          <tbody>${data.containers.map((c) => `
            <tr><td><strong>${esc(c.service)}</strong><br><span class="hint">${esc(c.name)}</span></td>
              <td><span class="badge ${c.state === 'running' ? 'running' : 'exited'}">${esc(c.state)}</span><br><span class="hint">${esc(c.status)}</span></td>
              <td><code>${esc(c.image)}</code></td>
              <td>${c.ports.map((p) => `<code>${esc(p)}</code>`).join('<br>') || '<span class="hint">—</span>'}</td></tr>`).join('')}
          </tbody></table></div>`
        : `<div class="card hint">${t('ct.empty')}</div>`;
    },

    logs() {
      const services = [...new Set((data.containers || []).map((c) => c.service).filter(Boolean))].sort();
      tab.innerHTML = `
        <div class="row" style="margin-bottom:10px">
          ${services.length > 1 ? `<select id="log-svc" class="lang" aria-label="${esc(t('logs.service'))}">
            <option value="">${t('logs.allServices')}</option>
            ${services.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('')}
          </select>` : ''}
          <label class="check" style="margin:0"><input type="checkbox" id="follow" checked> ${t('logs.live')}</label>
          <button class="btn small" id="reload">${t('logs.refresh')}</button>
        </div>
        <pre class="terminal tall" id="logs"></pre>`;
      const pre = document.getElementById('logs');
      const load = () => {
        stopStream();
        pre.textContent = '';
        const ctl = new AbortController();
        state.abort = ctl;
        const follow = document.getElementById('follow').checked ? 1 : 0;
        const svc = document.getElementById('log-svc')?.value || '';
        stream('GET', `/api/stacks/${name}/logs?tail=300&follow=${follow}${svc ? `&service=${encodeURIComponent(svc)}` : ''}`, (txt) => appendTo(pre, txt), ctl.signal)
          .catch((err) => { if (err.name !== 'AbortError') appendTo(pre, `\n${err.message}\n`); });
      };
      document.getElementById('reload').addEventListener('click', load);
      document.getElementById('follow').addEventListener('change', load);
      document.getElementById('log-svc')?.addEventListener('change', load);
      load();
    },

    async backups() {
      tab.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
      const b = await api('GET', '/api/backups').catch(() => null);
      if (currentTab !== 'backups') return;
      if (!b?.config?.configured) {
        tab.innerHTML = `<div class="card"><p class="hint">${t('bak.notConfigured')}</p>
          <a class="btn" href="#/settings/backups">${t('bak.goSettings')}</a></div>`;
        return;
      }
      tab.innerHTML = `
        <div class="card">
          <div class="row"><button type="button" class="btn primary" id="sb-run">${t('bak.runStack')}</button>
            <span class="hint">${t('bak.stackLead')}</span></div>
          <pre class="terminal" id="sb-log" hidden></pre>
        </div>
        <div class="card"><div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">${t('bak.snapshots')}</h2>
          <button type="button" class="btn small" id="sb-refresh" title="${esc(t('bak.refreshTitle'))}">${t('logs.refresh')}</button></div>
          <div id="sb-snaps"><p class="hint">${t('stack.loading')}</p></div></div>`;
      const loadSnaps = async (fresh = false) => {
        const box = document.getElementById('sb-snaps');
        if (fresh) box.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
        const list = await api('GET', `/api/backups/snapshots?stack=${encodeURIComponent(name)}${fresh ? '&fresh=1' : ''}`)
          .catch((err) => { box.innerHTML = errorBox(err); return null; });
        if (list && currentTab === 'backups') {
          snapshotsTable(box, list, {
            showStack: false,
            onRestored: (target) => { if (target !== name) location.hash = `#/stack/${target}`; else loadSnaps(); },
          });
        }
      };
      const runBtn = document.getElementById('sb-run');
      const follow = () => {
        runBtn.disabled = true;
        watchBackupJob(document.getElementById('sb-log'), (st) => {
          runBtn.disabled = false;
          toast(t(st.history?.[0]?.ok ? 'toast.done' : 'toast.failed'));
          loadSnaps();
        });
      };
      runBtn.addEventListener('click', async () => {
        try { await api('POST', `/api/stacks/${name}/backup`); } catch (err) { toast(err.message); return; }
        follow();
      });
      document.getElementById('sb-refresh').addEventListener('click', () => loadSnaps(true));
      if (b.status.running || b.status.queued) follow();
      loadSnaps();
    },

    async history() {
      const ops = await api('GET', `/api/stacks/${name}/operations`).catch(() => []);
      if (currentTab !== 'history') return;
      const STATUS = { ok: 'running', error: 'exited', running: 'partial', interrupted: 'exited' };
      tab.innerHTML = ops.length ? `
        <div class="card" style="padding:6px 8px"><table>
          <thead><tr><th>${t('hist.action')}</th><th>${t('hist.result')}</th><th>${t('hist.started')}</th><th></th></tr></thead>
          <tbody>${ops.map((o) => `<tr>
            <td>${esc(t(`act.${o.action}`))}</td>
            <td><span class="badge ${STATUS[o.status] || ''}">${esc(o.status)}</span></td>
            <td><span class="hint">${esc(o.started_at)} UTC</span></td>
            <td><button class="btn small" data-op="${o.id}">${t('hist.show')}</button></td></tr>`).join('')}
          </tbody></table></div><pre class="terminal" id="op-out" hidden></pre>`
        : `<div class="card hint">${t('hist.empty')}</div>`;
      tab.querySelectorAll('[data-op]').forEach((b) => b.addEventListener('click', async () => {
        const op = await api('GET', `/api/operations/${b.dataset.op}`);
        const pre = document.getElementById('op-out');
        pre.hidden = false;
        pre.textContent = op.output || t('hist.noOutput');
        pre.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }));
    },

    async domain() {
      tab.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
      let info;
      try {
        info = await api('GET', `/api/stacks/${name}/routes`);
      } catch (err) {
        tab.innerHTML = errorBox(err);
        return;
      }
      if (currentTab !== 'domain') return;
      if (!info.domain) {
        tab.innerHTML = `<div class="card"><p class="hint">${t('route.noDomain')}</p>
          <a class="btn" href="#/settings/domains">${t('route.goSettings')}</a></div>`;
        return;
      }
      let rows = info.routes.length ? info.routes.map((r) => ({ ...r })) : [];
      const svcOptions = (sel) => info.services.map((sv) =>
        `<option value="${esc(sv.name)}" ${sv.name === sel ? 'selected' : ''}>${esc(sv.name)}</option>`).join('');
      const suggestedPort = (svc) => info.services.find((x) => x.name === svc)?.ports?.[0] || '';
      const draw = () => {
        tab.innerHTML = `
          <div class="card">
            <h2>${t('route.title')}</h2>
            <p class="hint" style="margin-top:-4px">${t('route.lead', { domain: esc(info.domain) })}</p>
            <div id="route-rows">
              ${rows.map((r, i) => `
                <div class="route-row" data-i="${i}">
                  <div class="route-host"><input type="text" class="r-sub" value="${esc(r.subdomain)}" aria-label="${esc(t('route.subdomain'))}" placeholder="${esc(name)}" autocapitalize="off"><span>.${esc(info.domain)}</span></div>
                  <select class="r-svc lang" aria-label="${esc(t('route.service'))}">${svcOptions(r.service)}</select>
                  <input type="number" class="r-port" value="${esc(r.port)}" min="1" max="65535" aria-label="${esc(t('route.port'))}" placeholder="${esc(t('route.port'))}">
                  <button type="button" class="btn small danger r-del" aria-label="${esc(t('route.remove'))}">✕</button>
                </div>`).join('') || `<p class="hint">${t('route.none')}</p>`}
            </div>
            <p class="hint">${t('route.portHint')}</p>
            <div id="route-out"></div>
            <div class="row">
              <button type="button" class="btn" id="route-add">${t('route.add')}</button>
              <button type="button" class="btn primary" id="route-save">${t('edit.save')}</button>
            </div>
          </div>
          ${info.routes.length ? `<div class="card"><h2>${t('route.open')}</h2><ul class="link-list">${info.routes.map((r) =>
            `<li><a href="https://${esc(r.subdomain)}.${esc(info.domain)}" target="_blank" rel="noopener">https://${esc(r.subdomain)}.${esc(info.domain)}</a></li>`).join('')}</ul></div>` : ''}`;
        const read = () => {
          rows = [...tab.querySelectorAll('.route-row')].map((el) => ({
            subdomain: el.querySelector('.r-sub').value.trim().toLowerCase(),
            service: el.querySelector('.r-svc').value,
            port: Number(el.querySelector('.r-port').value),
          }));
        };
        tab.querySelectorAll('.r-svc').forEach((sel) => sel.addEventListener('change', (e) => {
          const port = e.target.closest('.route-row').querySelector('.r-port');
          if (!port.value) port.value = suggestedPort(e.target.value);
        }));
        tab.querySelectorAll('.r-del').forEach((b) => b.addEventListener('click', (e) => {
          read();
          rows.splice(Number(e.target.closest('.route-row').dataset.i), 1);
          draw();
        }));
        document.getElementById('route-add').addEventListener('click', () => {
          read();
          const svc = info.services[0]?.name || '';
          rows.push({ subdomain: rows.length ? '' : name, service: svc, port: suggestedPort(svc) });
          draw();
        });
        document.getElementById('route-save').addEventListener('click', async (e) => {
          read();
          e.target.disabled = true;
          const out = document.getElementById('route-out');
          out.innerHTML = `<p class="hint">${t('route.applying')}</p>`;
          try {
            const r = await api('PUT', `/api/stacks/${name}/routes`, { routes: rows });
            info.routes = r.routes;
            rows = r.routes.map((x) => ({ ...x }));
            draw();
            if (r.applied) toast(t('edit.saved'));
            else document.getElementById('route-out').innerHTML = `<div class="notice error">${esc(r.log.trim().split('\n').slice(-6).join('\n'))}</div>`;
          } catch (err) {
            out.innerHTML = errorBox(err);
            e.target.disabled = false;
          }
        });
      };
      draw();
    },

    delete() {
      tab.innerHTML = `
        <div class="card">
          <h2>${t('del.title')}</h2>
          <p class="hint">${t('del.lead')}</p>
          <div class="field"><label for="confirm">${t('del.confirm', { name: esc(name) })}</label>
            <input type="text" id="confirm" autocomplete="off" autocapitalize="off"></div>
          <div id="del-out"></div>
          <button class="btn danger" id="del">${t('del.button')}</button>
        </div>`;
      document.getElementById('del').addEventListener('click', async () => {
        try {
          await api('DELETE', `/api/stacks/${name}`, { confirm: document.getElementById('confirm').value });
          toast(t('del.done'));
          await refreshStacks();
          location.hash = '#/';
        } catch (err) {
          document.getElementById('del-out').innerHTML = errorBox(err);
        }
      });
    },
  };

  const showTab = (k) => {
    if (currentTab === 'logs' && k !== 'logs') stopStream();
    currentTab = k;
    main.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    revealActiveTab(main.querySelector('.tabs'), true);
    tabs[k]();
  };
  main.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  async function runAction(act) {
    const buttons = main.querySelectorAll('[data-act]');
    buttons.forEach((b) => (b.disabled = true));
    const wrap = document.getElementById('op-wrap');
    const pre = document.getElementById('op');
    const title = document.getElementById('op-title');
    const label = t(`act.${act}`);
    title.textContent = `${label}…`;
    wrap.hidden = false;
    pre.textContent = '';
    try {
      const code = await stream('POST', `/api/stacks/${name}/actions/${act}`, (txt) => appendTo(pre, txt));
      title.textContent = t(code === 0 ? 'act.done' : 'act.failed', { action: label });
      toast(t(code === 0 ? 'toast.done' : 'toast.failed'));
    } catch (err) {
      appendTo(pre, `\n${err.message}\n`);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      await refreshStacks();
      const s = state.stacks.find((x) => x.name === name);
      const badge = document.getElementById('badge');
      if (s && badge) {
        badge.className = `badge ${s.state}`;
        badge.textContent = stateLabel(s.state);
      }
      // compose.yaml may have gained volumes declared by the image
      const fresh = await api('GET', `/api/stacks/${name}`).catch(() => null);
      if (fresh) {
        data.compose = fresh.compose;
        data.containers = fresh.containers;
        if (currentTab === 'compose' || currentTab === 'containers') tabs[currentTab]();
        fillOpenButton(name, data.containers);
      }
    }
  }
  main.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.act === 'down' && !confirm(t('act.downConfirm'))) return;
    runAction(b.dataset.act);
  }));

  document.getElementById('stack-upd')?.addEventListener('click', () => {
    if (!confirm(t('upd.stackConfirm', { name }))) return;
    document.getElementById('stack-upd-box')?.remove();
    runAction('update');
  });

  tabs.compose();
  if (autostart) runAction('up');
}

// Scroll a tab bar sideways so its active tab is centred (only the bar moves, never the page).
function revealActiveTab(nav, smooth = false) {
  const on = nav?.querySelector('.on');
  if (!on) return;
  const left = nav.scrollLeft + on.getBoundingClientRect().left - nav.getBoundingClientRect().left
    - (nav.clientWidth - on.offsetWidth) / 2;
  nav.scrollTo({ left: Math.max(0, left), behavior: smooth ? 'smooth' : 'auto' });
}

const SETTINGS_TABS = ['general', 'domains', 'updates', 'backups', 'account'];

async function renderSettings(tab = 'general') {
  if (!SETTINGS_TABS.includes(tab)) tab = 'general';
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="head"><h1>${t('set.title')}</h1></div>
    <nav class="tabs" aria-label="${esc(t('set.title'))}">
      ${SETTINGS_TABS.map((k) => `<a href="#/settings/${k}" class="${k === tab ? 'on' : ''}"${k === tab ? ' aria-current="page"' : ''}>${t(`set.tab.${k}`)}</a>`).join('')}
    </nav>
    <div id="set-body"><p class="hint">${t('stack.loading')}</p></div>`;
  revealActiveTab(main.querySelector('.tabs'));
  const body = document.getElementById('set-body');
  const s = await api('GET', '/api/settings');
  if (route().page !== 'settings') return;
  ({ general: settingsGeneral, domains: settingsDomains, updates: settingsUpdates, backups: settingsBackups, account: settingsAccount })[tab](body, s);
}

function settingsGeneral(body, s) {
  body.innerHTML = `
    <div class="card">
      <h2>${t('set.language')}</h2>
      ${langSelect('set-lang')}
    </div>
    <form class="card" id="settings">
      <h2>${t('set.folders')}</h2>
      <p class="hint" style="margin-top:-4px">${t('set.foldersLead', { dir: esc(s.stacksDir) })}</p>
      <div class="row field">
        <div style="flex:1;min-width:120px"><label for="puid">${t('set.puid')}</label><input type="number" id="puid" value="${esc(s.puid)}"></div>
        <div style="flex:1;min-width:120px"><label for="pgid">${t('set.pgid')}</label><input type="number" id="pgid" value="${esc(s.pgid)}"></div>
      </div>
      <div class="field"><label for="allow">${t('set.allow')}</label>
        <textarea id="allow" class="code env" spellcheck="false">${esc(s.hostPathAllowlist.join('\n'))}</textarea>
        <p class="hint">${t('set.allowHint')}</p></div>
      <div id="s-out"></div>
      <button class="btn primary">${t('set.save')}</button>
    </form>`;
  bindLangSelect('set-lang');
  document.getElementById('settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', {
        puid: Number(document.getElementById('puid').value),
        pgid: Number(document.getElementById('pgid').value),
        hostPathAllowlist: document.getElementById('allow').value.split('\n'),
      });
      document.getElementById('s-out').innerHTML = '';
      toast(t('set.saved'));
    } catch (err) {
      document.getElementById('s-out').innerHTML = errorBox(err);
    }
  });
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(lang === 'pl' ? 'pl-PL' : 'en-GB') : t('upd.never'));
const showVersion = (v) => (!v ? '' : /^\d/.test(v) ? `v${v}` : v);

function settingsUpdates(body, s) {
  const u = state.updates || {};
  const p = u.panel || {};
  const mode = u.self?.mode || 'none';
  const stackNames = u.stacksWithUpdates || [];

  let panelBox = '';
  if (p.updateAvailable) {
    const howTo = mode === 'compose'
      ? `<button class="btn primary" id="upd-apply">${t('upd.apply')}</button>`
      : `<p class="hint">${t(`upd.how.${mode}`, { tag: esc(u.self?.tag || '') })}</p>`;
    panelBox = `
      <div class="notice info">
        <strong>${p.buildUpdate ? t('upd.newBuild') : t('upd.newVersion', { version: esc(showVersion(p.latest)) })}</strong>
        ${p.notes ? `<pre class="release-notes">${esc(p.notes)}</pre>` : ''}
        ${p.url ? `<p><a href="${esc(p.url)}" target="_blank" rel="noopener">${t('upd.releaseLink')}</a></p>` : ''}
        ${howTo}
      </div>`;
  } else if (p.checkedAt) {
    panelBox = `<p class="hint">${p.error ? t('upd.checkError') : t('upd.upToDate')}</p>`;
  }

  body.innerHTML = `
    <div class="card">
      <h2>Stackmoor</h2>
      <div class="kv">
        <span>${t('upd.current')}</span><strong>${esc(showVersion(p.current || state.version.replace(/^v/, '')))}</strong>
        <span>${t('upd.latest')}</span><strong>${esc(showVersion(p.latest) || '—')}</strong>
        <span>${t('upd.lastCheck')}</span><span>${esc(fmtDate(u.lastRun))}</span>
      </div>
      ${panelBox}
      <div id="upd-out"></div>
      <button class="btn" id="upd-check">${t(u.checking ? 'upd.checking' : 'upd.checkNow')}</button>
    </div>

    <div class="card">
      <h2>${t('upd.stacksTitle')}</h2>
      ${stackNames.length
        ? `<p class="hint">${t('upd.stacksLead')}</p><ul class="link-list">${stackNames.map((n) => `<li><a href="#/stack/${esc(n)}">${esc(n)}</a></li>`).join('')}</ul>`
        : `<p class="hint">${u.lastRun ? t('upd.stacksNone') : t('upd.never')}</p>`}
    </div>

    <form class="card" id="upd-form">
      <h2>${t('upd.settingsTitle')}</h2>
      <label class="check field"><input type="checkbox" id="upd-on" ${s.updateCheck ? 'checked' : ''}>
        <span>${t('upd.autoCheck')}</span></label>
      <div class="field"><label for="upd-int">${t('upd.interval')}</label>
        <select id="upd-int" class="lang">
          <option value="daily" ${s.updateInterval === 'daily' ? 'selected' : ''}>${t('upd.daily')}</option>
          <option value="weekly" ${s.updateInterval === 'weekly' ? 'selected' : ''}>${t('upd.weekly')}</option>
        </select></div>
      <label class="check field"><input type="checkbox" id="upd-stacks" ${s.updateCheckStacks ? 'checked' : ''}>
        <span>${t('upd.checkStacks')} <span class="hint">${t('upd.checkStacksHint')}</span></span></label>
      <p class="hint">${t('upd.neverAuto')}</p>
      <div id="upd-form-out"></div>
      <button class="btn primary">${t('set.save')}</button>
    </form>`;

  document.getElementById('upd-check').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = t('upd.checking');
    try {
      state.updates = await api('POST', '/api/updates/check');
      await refreshStacks();
      renderUpdateBadge();
      if (route().page === 'settings') settingsUpdates(body, s);
    } catch (err) {
      document.getElementById('upd-out').innerHTML = errorBox(err);
      e.target.disabled = false;
      e.target.textContent = t('upd.checkNow');
    }
  });

  document.getElementById('upd-apply')?.addEventListener('click', async (e) => {
    if (!confirm(t('upd.confirm', { version: showVersion(p.latest) || t('upd.newBuildShort') }))) return;
    e.target.disabled = true;
    const out = document.getElementById('upd-out');
    try {
      await api('POST', '/api/updates/apply');
      out.innerHTML = `<div class="notice info">${t('upd.restarting')}</div>`;
      waitForRestart();
    } catch (err) {
      out.innerHTML = errorBox(err);
      e.target.disabled = false;
    }
  });

  document.getElementById('upd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      Object.assign(s, await api('PUT', '/api/settings', {
        updateCheck: document.getElementById('upd-on').checked,
        updateInterval: document.getElementById('upd-int').value,
        updateCheckStacks: document.getElementById('upd-stacks').checked,
      }));
      document.getElementById('upd-form-out').innerHTML = '';
      toast(t('set.saved'));
    } catch (err) {
      document.getElementById('upd-form-out').innerHTML = errorBox(err);
    }
  });
}

// After a self-update the panel restarts. Reload as soon as a new panel process answers
// (its bootId changes); after 20 s reload anyway – if the update is still running,
// the reloaded page shows the notice again and keeps waiting.
let restartTimer = null;
function waitForRestart() {
  if (restartTimer) return;
  const before = state.bootId;
  const started = Date.now();
  restartTimer = setInterval(async () => {
    let st = null;
    try { st = await fetch('/api/state', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)); } catch { /* panel is down */ }
    // Reload only when the panel answers – never onto an error page while it is down.
    if (st && (st.bootId !== before || Date.now() - started >= 20e3)) {
      clearInterval(restartTimer);
      location.reload();
    }
  }, 2000);
}

async function settingsDomains(body) {
  let d;
  try {
    d = await api('GET', '/api/domains');
  } catch (err) {
    body.innerHTML = errorBox(err);
    return;
  }
  if (route().page !== 'settings') return;
  const st = d.status || {};
  const statusBox = !st.enabled ? '' : `
    <div class="card">
      <h2>${t('dom.status')}</h2>
      <div class="kv">
        <span>Caddy</span><strong>${st.running ? '✓ ' + t('dom.running') : '✕ ' + t('dom.stopped')}</strong>
        <span>${t('dom.cert')}</span><strong>${st.certificate ? `✓ *.${esc(st.domain)}` : t('dom.certWaiting')}</strong>
        ${st.panelUrl ? `<span>${t('dom.panelUrl')}</span><a href="${esc(st.panelUrl)}">${esc(st.panelUrl.replace('https://', ''))}</a>` : ''}
      </div>
      ${st.errors?.length ? `<div class="notice error">${st.errors.map(esc).join('\n')}</div>` : ''}
      ${st.imageProblem ? `<div class="notice info">${t('dom.caddyImageProblem', { image: esc(st.imageProblem) })}</div>` : ''}
      <p class="hint">${t('dom.dnsRecord', { domain: esc(st.domain) })}</p>
      <button type="button" class="btn small" id="dom-refresh">${t('logs.refresh')}</button>
    </div>`;

  const providerOptions = [
    `<option value="">${t('dom.chooseProvider')}</option>`,
    ...d.providers.map((p) => `<option value="${esc(p.id)}" ${p.id === d.dnsProvider ? 'selected' : ''}>${esc(p.name)}</option>`),
    `<option value="internal" ${d.dnsProvider === 'internal' ? 'selected' : ''}>${t('dom.internal')}</option>`,
  ].join('');

  const panelBox = !d.domain ? '' : `
    <form class="card" id="panel-form">
      <h2>${t('dom.panelTitle')}</h2>
      <div class="field"><label for="dom-panel">${t('dom.panelSub')}</label>
        <div class="row" style="align-items:center;gap:6px;flex-wrap:nowrap">
          <input type="text" id="dom-panel" value="${esc(d.panelSubdomain)}" placeholder="my" autocapitalize="off" autocomplete="off" style="flex:1;min-width:0">
          <span class="hint" style="white-space:nowrap">.${esc(d.domain)}</span>
        </div>
        <p class="hint">${t('dom.panelSubHint')}</p>
        <div id="dom-lock"></div></div>
      <div id="panel-out"></div>
      <button class="btn primary">${t('dom.panelSave')}</button>
    </form>`;

  body.innerHTML = `
    ${panelBox}
    ${statusBox}
    <form class="card" id="dom-form">
      <h2>${t('dom.title')}</h2>
      <p class="hint" style="margin-top:-4px">${t('dom.lead')}</p>
      <div class="field"><label for="dom-domain">${t('dom.domain')}</label>
        <input type="text" id="dom-domain" value="${esc(d.domain)}" placeholder="home.example.com" autocapitalize="off" autocomplete="off">
        <p class="hint">${t('dom.domainHint')}</p></div>
      <div class="field"><label for="dom-provider">${t('dom.provider')}</label>
        <select id="dom-provider" class="lang">${providerOptions}</select></div>
      <div id="dom-fields"></div>
      <div class="field"><label for="dom-email">${t('dom.email')} <span class="hint">${t('new.envOptional')}</span></label>
        <input type="text" id="dom-email" value="${esc(d.acmeEmail)}" placeholder="you@example.com" autocapitalize="off"></div>
      <details class="field"><summary>${t('dom.advanced')}</summary>
        <div class="row" style="margin-top:10px">
          <div style="flex:1;min-width:120px"><label for="dom-http">HTTP</label><input type="number" id="dom-http" value="${esc(d.httpPort)}"></div>
          <div style="flex:1;min-width:120px"><label for="dom-https">HTTPS</label><input type="number" id="dom-https" value="${esc(d.httpsPort)}"></div>
        </div>
        <p class="hint">${t('dom.portsHint')}</p>
      </details>
      <div id="dom-out"></div>
      <button class="btn primary">${t('dom.saveApply')}</button>
    </form>
    <div id="dom-op" hidden><pre class="terminal" id="dom-term"></pre></div>`;

  const drawFields = () => {
    const id = document.getElementById('dom-provider').value;
    const p = d.providers.find((x) => x.id === id);
    const box = document.getElementById('dom-fields');
    if (id === 'internal') {
      box.innerHTML = `<p class="hint field">${t('dom.internalHint')}</p>`;
      return;
    }
    if (!p) { box.innerHTML = ''; return; }
    const help = p.help?.[lang] || p.help?.en || '';
    box.innerHTML = `
      ${help ? `<p class="hint field">${esc(help)}</p>` : ''}
      ${p.fields.map((f) => {
        const saved = id === d.dnsProvider ? d.credentials?.[f.key] || '' : '';
        return `<div class="field"><label for="dns-${esc(f.key)}">${esc(f.label)}${f.required ? '' : ` <span class="hint">${t('new.envOptional')}</span>`}</label>
          <input type="${f.secret ? 'password' : 'text'}" id="dns-${esc(f.key)}" data-key="${esc(f.key)}" class="dns-field"
            value="${f.secret ? '' : esc(saved || f.default || '')}" placeholder="${esc(f.secret && saved ? saved : f.placeholder || '')}" autocomplete="off" autocapitalize="off"></div>`;
      }).join('')}`;
  };
  drawFields();
  document.getElementById('dom-provider').addEventListener('change', drawFields);

  // The IP lock can only be switched on from the panel's own address (proof that it works).
  const drawLock = () => {
    const box = document.getElementById('dom-lock');
    if (!box) return;
    const domain = d.domain;
    const sub = document.getElementById('dom-panel').value.trim().toLowerCase();
    if (!sub) { box.innerHTML = ''; return; }
    const url = `https://${sub}.${domain}`;
    const here = location.hostname === `${sub}.${domain}`;
    const prev = document.getElementById('dom-lock-on');
    const checked = prev ? prev.checked : d.panelDomainOnly;
    box.innerHTML = `
      <label class="check" style="margin-top:10px"><input type="checkbox" id="dom-lock-on" ${checked && (here || d.panelDomainOnly) ? 'checked' : ''} ${here || d.panelDomainOnly ? '' : 'disabled'}>
        ${t('dom.lock')}</label>
      <p class="hint">${here || d.panelDomainOnly ? t('dom.lockHint') : t('dom.lockOpenFirst', { url: esc(url) })}</p>`;
  };
  drawLock();
  document.getElementById('dom-panel')?.addEventListener('input', drawLock);
  document.getElementById('panel-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('panel-out');
    try {
      await api('PUT', '/api/domains/panel', {
        panelSubdomain: document.getElementById('dom-panel').value,
        panelDomainOnly: Boolean(document.getElementById('dom-lock-on')?.checked),
      });
      toast(t('toast.saved'));
      settingsDomains(body);
    } catch (err) {
      out.innerHTML = errorBox(err);
    }
  });
  document.getElementById('dom-refresh')?.addEventListener('click', () => settingsDomains(body));

  document.getElementById('dom-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('dom-out');
    const credentials = {};
    document.querySelectorAll('.dns-field').forEach((el) => { credentials[el.dataset.key] = el.value; });
    try {
      await api('PUT', '/api/domains', {
        domain: document.getElementById('dom-domain').value,
        dnsProvider: document.getElementById('dom-provider').value,
        acmeEmail: document.getElementById('dom-email').value,
        httpPort: Number(document.getElementById('dom-http').value),
        httpsPort: Number(document.getElementById('dom-https').value),
        credentials,
      });
      out.innerHTML = '';
    } catch (err) {
      out.innerHTML = errorBox(err);
      return;
    }
    const wrap = document.getElementById('dom-op');
    const pre = document.getElementById('dom-term');
    wrap.hidden = false;
    pre.textContent = '';
    const code = await stream('POST', '/api/domains/apply', (txt) => appendTo(pre, txt)).catch((err) => {
      appendTo(pre, `\n${err.message}\n`);
      return 1;
    });
    toast(t(code === 0 ? 'toast.done' : 'toast.failed'));
    if (code === 0) setTimeout(() => { if (route().tab === 'domains') settingsDomains(body); }, 8000);
  });
}

// ---------- backups ----------

const fmtBytes = (n) => {
  if (n === null || n === undefined) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
};

// Monday first; 0 = Sunday as in JavaScript.
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const dayName = (d) => new Intl.DateTimeFormat(lang === 'pl' ? 'pl-PL' : 'en-GB', { weekday: 'short' })
  .format(new Date(Date.UTC(2026, 0, 4 + d))); // 2026-01-04 was a Sunday

/** Shows the running backup job's log in `pre` until it finishes, then calls done(). */
function watchBackupJob(pre, done) {
  let stopped = false;
  const tick = async () => {
    if (stopped || !document.body.contains(pre)) return;
    const st = await api('GET', '/api/backups/status').catch(() => null);
    if (!st) return setTimeout(tick, 3000);
    pre.hidden = false;
    // Follow the end only if the user has not scrolled up to read.
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = st.log || '';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
    if (st.running || st.queued) setTimeout(tick, 2000);
    else done?.(st);
  };
  tick();
  return () => { stopped = true; };
}

function backupRunLabel(h) {
  const what = h.stack ? `${t(`bak.kind.${h.kind}`)} · ${esc(h.stack)}` : t(`bak.kind.${h.kind}`);
  const res = h.ok ? `<span class="badge running">✓</span>` : `<span class="badge exited">✕</span>`;
  const fail = h.failed?.length ? ` <span class="hint">${t('bak.failedFor', { list: esc(h.failed.join(', ')) })}</span>` : '';
  return `<tr><td>${fmtDate(h.at)}</td><td>${what}</td><td>${res}${fail}${h.error ? `<div class="hint" style="white-space:pre-wrap">${esc(h.error)}</div>` : ''}</td></tr>`;
}

/** Table of snapshots with restore. onRestored() runs after a restore finishes. */
function snapshotsTable(box, list, { showStack, onRestored }) {
  if (!list.length) {
    box.innerHTML = `<p class="hint">${t('bak.noSnapshots')}</p>`;
    return;
  }
  box.innerHTML = `
    <table class="snapshots"><thead><tr>
      ${showStack ? `<th>${t('bak.stack')}</th>` : ''}<th>${t('bak.date')}</th><th>${t('bak.size')}</th><th></th>
    </tr></thead><tbody>
    ${list.map((sn) => `<tr>
      ${showStack ? `<td>${esc(sn.stack)}</td>` : ''}
      <td>${fmtDate(sn.time)}${sn.preUpdate ? ` <span class="badge partial">${t('bak.preUpdate')}</span>` : ''}</td>
      <td class="hint">${fmtBytes(sn.size)}</td>
      <td><button type="button" class="btn small" data-restore="${esc(sn.id)}" data-stack="${esc(sn.stack)}">${t('bak.restore')}</button></td>
    </tr>`).join('')}
    </tbody></table>
    <form class="notice warn" id="restore-form" hidden>
      <strong id="restore-title"></strong>
      <p style="margin:6px 0">${t('bak.restoreLead')}</p>
      <div class="field"><label for="rs-target">${t('bak.restoreTarget')}</label>
        <input type="text" id="rs-target" autocapitalize="off" autocomplete="off">
        <p class="hint">${t('bak.restoreTargetHint')}</p></div>
      <div class="field"><label for="rs-confirm">${t('bak.restoreConfirm')}</label>
        <input type="text" id="rs-confirm" autocapitalize="off" autocomplete="off"></div>
      <div id="rs-out"></div>
      <div class="row"><button class="btn primary">${t('bak.restoreGo')}</button>
        <button type="button" class="btn" id="rs-cancel">${t('bak.cancel')}</button></div>
    </form>
    <pre class="terminal" id="rs-log" hidden></pre>`;
  const form = box.querySelector('#restore-form');
  let snapshot = null;
  box.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => {
    snapshot = b.dataset.restore;
    const sn = list.find((x) => x.id === snapshot);
    form.hidden = false;
    box.querySelector('#restore-title').textContent = t('bak.restoreTitle', { stack: sn.stack, date: fmtDate(sn.time) });
    box.querySelector('#rs-target').value = sn.stack;
    box.querySelector('#rs-confirm').value = '';
    box.querySelector('#rs-confirm').focus();
  }));
  box.querySelector('#rs-cancel').addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const target = box.querySelector('#rs-target').value.trim();
    try {
      await api('POST', '/api/backups/restore', { snapshot, target, confirm: box.querySelector('#rs-confirm').value.trim() });
    } catch (err) {
      box.querySelector('#rs-out').innerHTML = errorBox(err);
      return;
    }
    form.hidden = true;
    box.querySelectorAll('[data-restore]').forEach((b) => (b.disabled = true));
    watchBackupJob(box.querySelector('#rs-log'), (st) => {
      const last = st.history?.[0];
      toast(t(last?.ok ? 'toast.done' : 'toast.failed'));
      refreshStacks().catch(() => {});
      onRestored?.(target, last?.ok);
    });
  });
}

/** Backup runs (one nightly run = all stacks + the panel's settings), newest first. */
function runsTable(box, runs, onDone) {
  if (!runs.length) {
    box.innerHTML = `<p class="hint">${t('bak.noSnapshots')}</p>`;
    return;
  }
  box.innerHTML = `
    <div class="runs">${runs.map((r, i) => `
      <details class="run" ${i === 0 ? 'open' : ''}>
        <summary>
          <span class="run-date">${fmtDate(r.time)}</span>
          <span class="badge ${r.kind === 'pre-update' ? 'partial' : 'running'}">${esc(t(`bak.kind.${r.kind}`))}</span>
          <span class="hint">${t('bak.runStacks', { n: r.stacks.length })}${r.system ? ` · ${t('bak.runSettings')}` : ''}</span>
          <span class="hint run-size">${fmtBytes(r.size)}</span>
        </summary>
        <table><tbody>${r.stacks.map((sn) => `<tr>
          <td>${esc(sn.stack)}</td><td class="hint">${fmtBytes(sn.size)}</td>
          <td style="text-align:right"><button type="button" class="btn small" data-one="${esc(sn.id)}" data-stack="${esc(sn.stack)}">${t('bak.restore')}</button></td>
        </tr>`).join('')}</tbody></table>
        ${r.stacks.length > 1 ? `<button type="button" class="btn small" data-all="${esc(r.id)}">${t('bak.restoreAll')}</button>` : ''}
      </details>`).join('')}
    </div>
    <form class="notice warn" id="rr-form" hidden>
      <strong id="rr-title"></strong>
      <p style="margin:6px 0" id="rr-lead"></p>
      <div id="rr-one">
        <div class="field"><label for="rr-target">${t('bak.restoreTarget')}</label>
          <input type="text" id="rr-target" autocapitalize="off" autocomplete="off">
          <p class="hint">${t('bak.restoreTargetHint')}</p></div>
        <div class="field"><label for="rr-confirm">${t('bak.restoreConfirm')}</label>
          <input type="text" id="rr-confirm" autocapitalize="off" autocomplete="off"></div>
      </div>
      <label class="check field" id="rr-all"><input type="checkbox" id="rr-all-ok"> ${t('bak.restoreAllConfirm')}</label>
      <div id="rr-out"></div>
      <div class="row"><button class="btn primary">${t('bak.restoreGo')}</button>
        <button type="button" class="btn" id="rr-cancel">${t('bak.cancel')}</button></div>
    </form>
    <pre class="terminal" id="rr-log" hidden></pre>`;

  const form = box.querySelector('#rr-form');
  let mode = null;
  let target = null;
  const open = () => { form.hidden = false; form.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
  box.querySelectorAll('[data-one]').forEach((b) => b.addEventListener('click', () => {
    const run = runs.find((r) => r.stacks.some((x) => x.id === b.dataset.one));
    mode = 'one';
    target = b.dataset.one;
    box.querySelector('#rr-title').textContent = t('bak.restoreTitle', { stack: b.dataset.stack, date: fmtDate(run.time) });
    box.querySelector('#rr-lead').textContent = t('bak.restoreLead');
    box.querySelector('#rr-one').hidden = false;
    box.querySelector('#rr-all').hidden = true;
    box.querySelector('#rr-target').value = b.dataset.stack;
    box.querySelector('#rr-confirm').value = '';
    open();
    box.querySelector('#rr-confirm').focus();
  }));
  box.querySelectorAll('[data-all]').forEach((b) => b.addEventListener('click', () => {
    const run = runs.find((r) => r.id === b.dataset.all);
    mode = 'all';
    target = run.id;
    box.querySelector('#rr-title').textContent = t('bak.restoreAllTitle', { date: fmtDate(run.time) });
    box.querySelector('#rr-lead').textContent = t('bak.restoreAllLead', { list: run.stacks.map((x) => x.stack).join(', ') });
    box.querySelector('#rr-one').hidden = true;
    box.querySelector('#rr-all').hidden = false;
    box.querySelector('#rr-all-ok').checked = false;
    open();
  }));
  box.querySelector('#rr-cancel').addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (mode === 'one') {
        const name = box.querySelector('#rr-target').value.trim();
        await api('POST', '/api/backups/restore', { snapshot: target, target: name, confirm: box.querySelector('#rr-confirm').value.trim() });
      } else {
        await api('POST', '/api/backups/restore-run', { run: target, confirm: box.querySelector('#rr-all-ok').checked });
      }
    } catch (err) {
      box.querySelector('#rr-out').innerHTML = errorBox(err);
      return;
    }
    form.hidden = true;
    box.querySelectorAll('[data-one],[data-all]').forEach((b) => (b.disabled = true));
    watchBackupJob(box.querySelector('#rr-log'), (st) => {
      toast(t(st.history?.[0]?.ok ? 'toast.done' : 'toast.failed'));
      refreshStacks().catch(() => {});
      setTimeout(onDone, 2500);
    });
  });
}

async function settingsBackups(body) {
  let d;
  try {
    d = await api('GET', '/api/backups');
  } catch (err) {
    body.innerHTML = errorBox(err);
    return;
  }
  if (route().page !== 'settings') return;
  const c = d.config;
  const st = d.status;
  const last = st.history?.find((h) => h.kind !== 'restore' && h.kind !== 'verify');
  const verify = st.verifyData || st.verify;

  const statusBox = !c.configured ? '' : `
    <div class="card">
      <h2>${t('bak.status')}</h2>
      <div class="kv">
        <span>${t('bak.lastRun')}</span><strong>${last ? `${last.ok ? '✓' : '✕'} ${fmtDate(last.at)}` : t('upd.never')}</strong>
        <span>${t('bak.checksums')}</span><strong>${verify ? `${verify.ok ? '✓' : '✕'} ${fmtDate(verify.at)} · ${t(`bak.mode.${verify.mode}`)}` : t('upd.never')}</strong>
        <span>${t('bak.schedule')}</span><strong>${c.enabled && c.days.length ? `${WEEK.filter((x) => c.days.includes(x)).map(dayName).join(', ')} · ${esc(c.time)}` : t('bak.off')}</strong>
      </div>
      ${verify && !verify.ok ? `<div class="notice error">${t('bak.verifyBad')}\n${esc(verify.error || '')}</div>` : ''}
      <div class="row">
        <button type="button" class="btn primary" id="bak-run">${t('bak.runNow')}</button>
        <button type="button" class="btn" id="bak-verify" title="${esc(t('bak.verifyTitle'))}">${t('bak.verifyNow')}</button>
      </div>
      <pre class="terminal" id="bak-log" hidden></pre>
      ${st.history?.length ? `<details style="margin-top:12px"><summary>${t('bak.history')}</summary>
        <table><tbody>${st.history.map(backupRunLabel).join('')}</tbody></table></details>` : ''}
    </div>`;

  const destOptions = c.destinations.map((x) => `<option value="${esc(x.id)}" ${x.id === c.destination ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  body.innerHTML = `
    ${statusBox}
    <form class="card" id="bak-form">
      <h2>${t('bak.storage')}</h2>
      <p class="hint" style="margin-top:-4px">${t('bak.lead')}</p>
      <div class="field"><label for="bk-dest">${t('bak.destination')}</label>
        <select id="bk-dest" class="lang">${destOptions}</select>
        <p class="hint" id="bk-help"></p></div>
      <div class="row field">
        <div style="flex:3;min-width:220px"><label for="bk-endpoint">${t('bak.endpoint')}</label>
          <input type="text" id="bk-endpoint" value="${esc(c.endpoint)}" autocapitalize="off" autocomplete="off"></div>
        <div style="flex:1;min-width:120px"><label for="bk-region">${t('bak.region')}</label>
          <input type="text" id="bk-region" value="${esc(c.region)}" autocapitalize="off" autocomplete="off"></div>
      </div>
      <div class="row field">
        <div style="flex:2;min-width:180px"><label for="bk-bucket">${t('bak.bucket')}</label>
          <input type="text" id="bk-bucket" value="${esc(c.bucket)}" autocapitalize="off" autocomplete="off"></div>
        <div style="flex:1;min-width:120px"><label for="bk-prefix">${t('bak.prefix')}</label>
          <input type="text" id="bk-prefix" value="${esc(c.prefix)}" autocapitalize="off" autocomplete="off"></div>
      </div>
      <div class="field"><label for="bk-ak">${t('bak.accessKey')}</label>
        <input type="text" id="bk-ak" value="${esc(c.accessKey)}" autocapitalize="off" autocomplete="off"></div>
      <div class="field"><label for="bk-sk">${t('bak.secretKey')}</label>
        <input type="password" id="bk-sk" placeholder="${esc(c.secretKey)}" autocomplete="off"></div>

      <h2 style="margin-top:22px">${t('bak.encryption')}</h2>
      <div class="field"><label for="bk-pw">${t('bak.password')}</label>
        <div class="row" style="flex-wrap:nowrap">
          <input type="password" id="bk-pw" placeholder="${esc(c.password)}" autocomplete="new-password" style="flex:1;min-width:0">
          <button type="button" class="btn" id="bk-gen">${t('bak.generate')}</button>
          ${c.password ? `<button type="button" class="btn" id="bk-show">${t('bak.show')}</button>` : ''}
        </div></div>
      <div class="notice warn">${t('bak.passwordWarn')}</div>

      <h2 style="margin-top:22px">${t('bak.scheduleTitle')}</h2>
      <label class="check field"><input type="checkbox" id="bk-enabled" ${c.enabled ? 'checked' : ''}> ${t('bak.enabled')}</label>
      <div class="field"><label>${t('bak.days')}</label>
        <div class="row days">${WEEK.map((x) => `<label class="check"><input type="checkbox" class="bk-day" value="${x}" ${c.days.includes(x) ? 'checked' : ''}> ${esc(dayName(x))}</label>`).join('')}</div></div>
      <div class="field" style="max-width:180px"><label for="bk-time">${t('bak.time')}</label>
        <input type="time" id="bk-time" value="${esc(c.time)}"></div>
      <p class="hint field">${t('bak.timeZone', { zone: esc(Intl.DateTimeFormat().resolvedOptions().timeZone) })}</p>

      <h2 style="margin-top:22px">${t('bak.retention')}</h2>
      <p class="hint" style="margin-top:-4px">${t('bak.retentionLead')}</p>
      <div class="row field">
        <div style="flex:1;min-width:110px"><label for="bk-kd">${t('bak.keepDaily')}</label><input type="number" min="0" id="bk-kd" value="${esc(c.keepDaily)}"></div>
        <div style="flex:1;min-width:110px"><label for="bk-kw">${t('bak.keepWeekly')}</label><input type="number" min="0" id="bk-kw" value="${esc(c.keepWeekly)}"></div>
        <div style="flex:1;min-width:110px"><label for="bk-km">${t('bak.keepMonthly')}</label><input type="number" min="0" id="bk-km" value="${esc(c.keepMonthly)}"></div>
      </div>
      <label class="check field"><input type="checkbox" id="bk-before" ${c.beforeUpdate ? 'checked' : ''}> ${t('bak.beforeUpdate')}</label>
      <label class="check field"><input type="checkbox" id="bk-vw" ${c.verifyWeekly ? 'checked' : ''}> ${t('bak.verifyWeekly')}</label>

      <div id="bk-out"></div>
      <button class="btn primary">${t('bak.saveTest')}</button>
    </form>
    ${c.configured ? `<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">${t('bak.snapshots')}</h2>
      <button type="button" class="btn small" id="bk-refresh" title="${esc(t('bak.refreshTitle'))}">${t('logs.refresh')}</button></div>
      <div id="bk-snaps"><p class="hint">${t('stack.loading')}</p></div></div>` : ''}`;

  // Destination presets: help text, and the address filled in from the region.
  const epFor = (dest, region) => (dest?.endpoint && !dest.endpoint.includes('<') ? dest.endpoint.replace('{region}', region) : '');
  let autoEp = null;
  const drawDest = (fill) => {
    const dest = c.destinations.find((x) => x.id === document.getElementById('bk-dest').value);
    document.getElementById('bk-help').textContent = dest?.help?.[lang] || dest?.help?.en || '';
    const ep = document.getElementById('bk-endpoint');
    const rg = document.getElementById('bk-region');
    if (fill) {
      rg.value = dest?.region || '';
      ep.value = epFor(dest, rg.value);
      autoEp = ep.value;
    } else if (autoEp !== null && ep.value === autoEp) {
      ep.value = epFor(dest, rg.value);
      autoEp = ep.value;
    }
    ep.placeholder = (dest?.endpoint || 'minio.example.com:9000').replace('{region}', rg.value || dest?.region || '');
  };
  drawDest(!c.endpoint);
  document.getElementById('bk-dest').addEventListener('change', () => drawDest(true));
  document.getElementById('bk-region').addEventListener('input', () => drawDest(false));

  document.getElementById('bk-gen').addEventListener('click', () => {
    const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(28));
    const pw = Array.from(bytes, (b) => abc[b % abc.length]).join('');
    const el = document.getElementById('bk-pw');
    el.type = 'text';
    el.value = pw;
    el.select();
  });
  document.getElementById('bk-show')?.addEventListener('click', async () => {
    const r = await api('POST', '/api/backups/reveal').catch(() => null);
    if (!r) return;
    const el = document.getElementById('bk-pw');
    el.type = 'text';
    el.value = r.password;
    el.select();
  });

  document.getElementById('bak-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('bk-out');
    const val = (id) => document.getElementById(id).value;
    const ep = document.getElementById('bk-endpoint');
    try {
      await api('PUT', '/api/backups', {
        destination: val('bk-dest'),
        endpoint: ep.value.trim(),
        region: val('bk-region').trim(),
        bucket: val('bk-bucket'),
        prefix: val('bk-prefix'),
        accessKey: val('bk-ak'),
        secretKey: val('bk-sk'),
        password: val('bk-pw'),
        enabled: document.getElementById('bk-enabled').checked,
        days: [...document.querySelectorAll('.bk-day:checked')].map((x) => Number(x.value)),
        time: val('bk-time'),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        keepDaily: Number(val('bk-kd')),
        keepWeekly: Number(val('bk-kw')),
        keepMonthly: Number(val('bk-km')),
        beforeUpdate: document.getElementById('bk-before').checked,
        verifyWeekly: document.getElementById('bk-vw').checked,
      });
      out.innerHTML = `<p class="hint">${t('bak.testing')}</p>`;
      const r = await api('POST', '/api/backups/test');
      toast(t(r.created ? 'bak.repoCreated' : 'bak.repoOk'));
      settingsBackups(body);
    } catch (err) {
      out.innerHTML = errorBox(err);
    }
  });

  const startJob = async (url) => {
    document.getElementById('bak-run').disabled = true;
    document.getElementById('bak-verify').disabled = true;
    if (url) { try { await api('POST', url); } catch (err) { toast(err.message); } }
    watchBackupJob(document.getElementById('bak-log'), (s2) => {
      toast(t(s2.history?.[0]?.ok ? 'toast.done' : 'toast.failed'));
      setTimeout(() => { if (route().tab === 'backups') settingsBackups(body); }, 1500);
    });
  };
  document.getElementById('bak-run')?.addEventListener('click', () => startJob('/api/backups/run'));
  document.getElementById('bak-verify')?.addEventListener('click', () => startJob('/api/backups/verify'));
  if (st.running || st.queued) startJob(null); // a job is already running: just follow it

  const snapsBox = document.getElementById('bk-snaps');
  const loadAll = async (fresh = false) => {
    if (fresh) snapsBox.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
    const list = await api('GET', `/api/backups/runs${fresh ? '?fresh=1' : ''}`).catch((err) => { snapsBox.innerHTML = errorBox(err); return null; });
    if (list && route().tab === 'backups') runsTable(snapsBox, list.filter((r) => r.stacks.length), () => loadAll());
  };
  if (snapsBox) {
    document.getElementById('bk-refresh').addEventListener('click', () => loadAll(true));
    loadAll();
  }
}

function settingsAccount(body) {
  body.innerHTML = `
    <form class="card" id="pw">
      <h2>${t('pw.title')}</h2>
      <div class="field"><label for="cur">${t('pw.current')}</label><input type="password" id="cur" autocomplete="current-password" required></div>
      <div class="field"><label for="nw">${t('pw.new')}</label><input type="password" id="nw" autocomplete="new-password" minlength="10" required></div>
      <div id="pw-out"></div>
      <button class="btn">${t('pw.submit')}</button>
    </form>
    <div class="card phone-only">
      <h2>${t('nav.logout')}</h2>
      <p class="hint">${t('acc.signedInAs', { user: esc(state.user?.username || '') })}</p>
      <button type="button" class="btn" id="acc-logout">${t('nav.logout')}</button>
    </div>`;
  document.getElementById('acc-logout').addEventListener('click', async () => {
    await api('POST', '/api/logout').catch(() => {});
    state.user = null;
    render();
  });
  document.getElementById('pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/password', { current: document.getElementById('cur').value, next: document.getElementById('nw').value });
      e.target.reset();
      document.getElementById('pw-out').innerHTML = '';
      toast(t('pw.done'));
    } catch (err) {
      document.getElementById('pw-out').innerHTML = errorBox(err);
    }
  });
}

function renderUpdateBadge() {
  const el = document.getElementById('panel-update');
  if (!el) return;
  const p = state.updates?.panel;
  el.hidden = !p?.updateAvailable;
  el.textContent = p?.updateAvailable
    ? (p.buildUpdate ? t('upd.badgeBuild') : t('upd.badge', { version: showVersion(p.latest) }))
    : t('upd.badgeBuild');
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
  document.querySelectorAll('.bottom-nav a').forEach((a) => {
    const on = a.dataset.nav === (r.page === 'settings' ? 'settings' : 'home');
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (r.page === 'new') renderNew();
  else if (r.page === 'settings') renderSettings(r.tab);
  else if (r.page === 'stack') renderStack(r.name);
  else renderHome();
}

async function boot() {
  const s = await api('GET', '/api/state');
  state.user = s.user;
  state.needsSetup = s.needsSetup;
  if (s.restoring) state.wizard = 'progress';
  state.version = !s.version ? '' : /^\d/.test(s.version) ? `v${s.version}` : s.version;
  state.stacksDir = s.stacksDir;
  state.stacksDirOk = s.stacksDirOk;
  state.bootId = s.bootId;
  state.updating = Boolean(s.updating);
  if (state.user) {
    state.stacks = await api('GET', '/api/stacks').catch(() => []);
    state.updates = await api('GET', '/api/updates').catch(() => null);
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(refreshStacks, 10_000);
  }
  render();
  // Opened (or reloaded) while a self-update is still running: keep waiting for the new panel.
  if (state.user && state.updating) waitForRestart();
}

window.addEventListener('hashchange', render);
boot();
