// Moorline UI – no framework, no build step.
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
  'X-Requested-With': 'moorline',
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
  const setup = state.needsSetup;
  app.innerHTML = `
    <div class="auth"><form class="card" id="auth">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <img src="/logo.svg" alt="Moorline" width="52" height="52">${langSelect('auth-lang')}
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
    </form></div>`;
  bindLangSelect('auth-lang');
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

// ---------- layout ----------

const LOGO = `<img src="/logo.svg" alt="" width="28" height="28">`;

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
          <a class="brand" href="#/" title="${esc(t('home.title'))}">${LOGO}<span>Moorline</span></a><span class="version">${esc(state.version)}</span>
          <a class="btn primary new" href="#/new">${t('nav.newStack')}</a>
          <ul class="stack-list" id="stack-list"></ul>
          <div class="sidebar-foot">
            <a class="btn small" href="#/settings">${t('nav.settings')}</a>
            <button class="btn small" id="logout">${t('nav.logout')}</button>
          </div>
        </aside>
        <div class="main-wrap"><div id="global-warning"></div><main class="main" id="main"></main></div>
      </div>`;
    document.getElementById('logout').addEventListener('click', async () => {
      await api('POST', '/api/logout').catch(() => {});
      state.user = null;
      render();
    });
  }
  renderStackList();
  const warn = document.getElementById('global-warning');
  if (warn) {
    warn.innerHTML = state.stacksDirOk === false
      ? `<div class="notice error global">${t('warn.stacksDir', { dir: esc(state.stacksDir) })}</div>`
      : '';
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
        <div><strong>${esc(s.name)}</strong><br><span class="hint">${esc(stateLabel(s.state))}${s.total ? ` · ${s.running}/${s.total}` : ''}</span></div>
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
      </div>
    </div>
    <div id="notice"></div>
    <div id="op-wrap" hidden><h2 id="op-title">${t('act.operation')}</h2><pre class="terminal" id="op"></pre><br></div>
    <div class="tabs" role="tablist">
      ${['compose', 'env', 'containers', 'logs', 'history', 'delete']
        .map((k, i) => `<button data-tab="${k}" class="${i === 0 ? 'on' : ''}">${t(`tab.${k}`)}</button>`).join('')}
    </div>
    <div id="tab"></div>`;

  let autostart = false;
  if (state.pendingNotice?.name === name) {
    document.getElementById('notice').innerHTML = notices(state.pendingNotice.result);
    autostart = state.pendingNotice.autostart;
    state.pendingNotice = null;
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
      tab.innerHTML = `
        <div class="row" style="margin-bottom:10px">
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
        stream('GET', `/api/stacks/${name}/logs?tail=300&follow=${follow}`, (txt) => appendTo(pre, txt), ctl.signal)
          .catch((err) => { if (err.name !== 'AbortError') appendTo(pre, `\n${err.message}\n`); });
      };
      document.getElementById('reload').addEventListener('click', load);
      document.getElementById('follow').addEventListener('change', load);
      load();
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
      }
    }
  }
  main.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.act === 'down' && !confirm(t('act.downConfirm'))) return;
    runAction(b.dataset.act);
  }));

  tabs.compose();
  if (autostart) runAction('up');
}

async function renderSettings() {
  const main = document.getElementById('main');
  const s = await api('GET', '/api/settings');
  main.innerHTML = `
    <div class="head"><h1>${t('set.title')}</h1></div>
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
    </form>
    <form class="card" id="pw">
      <h2>${t('pw.title')}</h2>
      <div class="field"><label for="cur">${t('pw.current')}</label><input type="password" id="cur" autocomplete="current-password" required></div>
      <div class="field"><label for="nw">${t('pw.new')}</label><input type="password" id="nw" autocomplete="new-password" minlength="10" required></div>
      <div id="pw-out"></div>
      <button class="btn">${t('pw.submit')}</button>
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
  state.version = s.version ? `v${s.version}` : '';
  state.stacksDir = s.stacksDir;
  state.stacksDirOk = s.stacksDirOk;
  if (state.user) {
    state.stacks = await api('GET', '/api/stacks').catch(() => []);
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(refreshStacks, 10_000);
  }
  render();
}

window.addEventListener('hashchange', render);
boot();
