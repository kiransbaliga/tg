// ---- tiny helpers -------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const KIND_ICON = { group: '👥', supergroup: '👥', channel: '📢', user: '👤', bot: '🤖' };

function fmtDuration(sec) {
  if (!sec && sec !== 0) return '';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function dayKey(unixSec) {
  const d = new Date(unixSec * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function dayLabel(unixSec) {
  const d = new Date(unixSec * 1000);
  const now = new Date();
  const opts = { weekday: 'long', month: 'long', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

// ---- state --------------------------------------------------------------

const state = {
  status: null,
  albums: [],
  current: null,      // chatId
  media: [],          // flat, date-desc
  total: 0,
  offset: 0,
  pageSize: 200,
  loading: false,
  gen: 0,             // bumped on album switch; stale in-flight loads self-discard
  syncTimers: new Map(),
};

const IMAGE_TYPES = new Set(['photo', 'image']);

// ---- status / header ----------------------------------------------------

async function loadStatus() {
  state.status = await api('/api/status');
  const box = $('#status');
  box.innerHTML = '';
  const s = state.status;
  if (!s.hasCredentials) {
    box.append(el('span', 'pill warn', 'Setup needed — add API keys to .env'));
  } else if (!s.authenticated) {
    box.append(el('span', 'pill warn', 'Not logged in — run <code>npm run login</code>'));
  } else {
    const name = [s.me?.firstName, s.me?.lastName].filter(Boolean).join(' ') || s.me?.username || 'account';
    box.append(el('span', 'pill', `Signed in as ${name}`));
  }
}

function canUseTelegram() {
  return state.status?.hasCredentials && state.status?.authenticated;
}

// ---- albums / sidebar ---------------------------------------------------

async function loadAlbums() {
  state.albums = await api('/api/albums');
  renderSidebar();
}

function renderSidebar() {
  const list = $('#album-list');
  list.innerHTML = '';
  if (!state.albums.length) {
    list.append(el('div', 'album-sub', '<div style="padding:10px 12px;line-height:1.5">No albums yet.<br>Click <b>+ Add</b> to pick a Telegram chat.</div>'));
    return;
  }
  for (const a of state.albums) {
    const row = el('div', 'album' + (a.chat_id === state.current ? ' active' : ''));
    row.dataset.chatId = a.chat_id;
    const icon = el('div', 'album-icon', KIND_ICON[a.kind] || '📁');
    const body = el('div', 'album-body');
    body.append(el('div', 'album-title', escapeHtml(a.title || a.chat_id)));
    const syncing = state.syncTimers.has(a.chat_id);
    body.append(el('div', 'album-sub', syncing ? 'Syncing…' : `${a.media_count} item${a.media_count === 1 ? '' : 's'}`));
    const sync = el('button', 'album-sync' + (syncing ? ' spinning' : ''), '↻');
    sync.title = 'Sync from Telegram';
    sync.addEventListener('click', (e) => { e.stopPropagation(); startSync(a.chat_id); });
    row.append(icon, body, sync);
    row.addEventListener('click', () => selectAlbum(a.chat_id));
    list.append(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- select + load media ------------------------------------------------

async function selectAlbum(chatId) {
  state.gen++;              // abandon any in-flight load for the previous album
  state.loading = false;
  state.current = chatId;
  state.media = [];
  state.offset = 0;
  state.total = 0;
  renderSidebar();
  renderMainHead();
  $('#gallery').innerHTML = '';
  $('#empty').classList.add('hidden');
  await loadMore();
}

function renderMainHead() {
  const head = $('#main-head');
  const a = state.albums.find((x) => x.chat_id === state.current);
  if (!a) { head.innerHTML = ''; return; }
  head.innerHTML = '';
  const left = el('div');
  left.append(el('h1', null, escapeHtml(a.title || a.chat_id)));
  left.append(el('div', 'meta', `${state.total || a.media_count} items · ${a.downloaded_count} downloaded`));
  const actions = el('div', 'head-actions');
  const syncBtn = el('button', 'btn btn-primary', state.syncTimers.has(a.chat_id) ? 'Syncing…' : '↻ Sync');
  syncBtn.disabled = state.syncTimers.has(a.chat_id);
  syncBtn.addEventListener('click', () => startSync(a.chat_id));
  actions.append(syncBtn);
  head.append(left, actions);
}

async function loadMore() {
  if (!state.current || state.loading) return;
  if (state.media.length && state.media.length >= state.total) return;
  const gen = state.gen;
  const chatId = state.current;
  state.loading = true;
  try {
    const data = await api(`/api/albums/${chatId}/media?limit=${state.pageSize}&offset=${state.offset}`);
    if (gen !== state.gen) return; // album switched mid-fetch — discard this stale page
    state.total = data.total;
    state.offset += data.items.length;
    state.media.push(...data.items);
    renderGallery();
    renderMainHead();
    if (!state.media.length) showEmptyForAlbum();
  } catch (err) {
    console.error(err);
  } finally {
    if (gen === state.gen) state.loading = false;
  }
}

function showEmptyForAlbum() {
  const empty = $('#empty');
  empty.classList.remove('hidden');
  empty.innerHTML = canUseTelegram()
    ? 'No media synced yet for this album.<br>Click <b>↻ Sync</b> to pull photos & videos from Telegram.'
    : 'Log in first: run <code>npm run login</code> in the project folder, then reload.';
}

// ---- gallery layout (justified rows, grouped by day) --------------------

function aspectOf(it) {
  const w = it.width || 0, h = it.height || 0;
  if (w > 0 && h > 0) return Math.max(0.35, Math.min(3, w / h));
  return 1;
}

function renderGallery() {
  const gallery = $('#gallery');
  gallery.innerHTML = '';
  if (!state.media.length) return;

  const containerWidth = gallery.clientWidth || (gallery.parentElement.clientWidth - 48);
  const targetH = 200;
  const gap = 4;

  // group by day (state.media is already date-desc)
  const groups = [];
  let cur = null;
  for (const it of state.media) {
    const key = dayKey(it.date || 0);
    if (!cur || cur.key !== key) { cur = { key, date: it.date, items: [] }; groups.push(cur); }
    cur.items.push(it);
  }

  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const groupEl = el('div', 'day-group');
    groupEl.append(el('div', 'day-label', escapeHtml(dayLabel(g.date || 0))));
    for (const row of packRows(g.items, containerWidth, targetH, gap)) {
      const rowEl = el('div', 'row');
      for (const it of row.items) {
        rowEl.append(makeTile(it, Math.round(row.height * aspectOf(it)), Math.round(row.height)));
      }
      groupEl.append(rowEl);
    }
    frag.append(groupEl);
  }
  gallery.append(frag);
}

function packRows(items, containerWidth, targetH, gap) {
  const rows = [];
  let row = [], aspectSum = 0;
  for (const it of items) {
    row.push(it);
    aspectSum += aspectOf(it);
    const widthAtTarget = aspectSum * targetH + gap * (row.length - 1);
    if (widthAtTarget >= containerWidth) {
      rows.push({ items: row, height: (containerWidth - gap * (row.length - 1)) / aspectSum });
      row = []; aspectSum = 0;
    }
  }
  if (row.length) {
    const fill = (containerWidth - gap * (row.length - 1)) / aspectSum;
    rows.push({ items: row, height: Math.min(targetH * 1.15, fill) });
  }
  return rows;
}

function makeTile(it, w, h) {
  const idx = state.media.indexOf(it);
  const tile = el('div', 'tile');
  tile.style.width = `${w}px`;
  tile.style.height = `${h}px`;
  tile.dataset.index = idx;

  const img = el('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = `/api/media/${it.id}/thumb`;
  img.addEventListener('error', () => {
    tile.classList.add('noimg');
    img.remove();
    tile.prepend(el('div', null, it.type === 'video' ? '🎬' : '🖼️'));
  }, { once: true });
  tile.append(img);

  if (it.type === 'video') {
    const play = el('div', 'play', '<span>▶</span>');
    tile.append(play);
    if (it.duration) tile.append(el('div', 'badge', fmtDuration(it.duration)));
  } else if (it.type === 'gif') {
    tile.append(el('div', 'badge', 'GIF'));
  }
  return tile;
}

// ---- sync ---------------------------------------------------------------

async function startSync(chatId) {
  if (!canUseTelegram()) {
    alert(state.status?.hasCredentials
      ? 'Not logged in. Run "npm run login" in the project folder, then reload.'
      : 'Add TG_API_ID and TG_API_HASH to your .env file, then run "npm run login".');
    return;
  }
  if (state.syncTimers.has(chatId)) return;
  try {
    await api(`/api/albums/${chatId}/sync`, { method: 'POST' });
  } catch (err) {
    alert('Sync failed to start: ' + err.message);
    return;
  }
  const timer = setInterval(() => pollSync(chatId), 1500);
  state.syncTimers.set(chatId, timer);
  renderSidebar();
  renderMainHead();
}

async function pollSync(chatId) {
  let st;
  try { st = await api(`/api/albums/${chatId}/sync/status`); }
  catch { return; }
  if (st && st.running === false) {
    clearInterval(state.syncTimers.get(chatId));
    state.syncTimers.delete(chatId);
    await loadAlbums();
    if (chatId === state.current) {
      // reload media from scratch to show newly synced items
      const keep = state.current;
      await selectAlbum(keep);
    } else {
      renderMainHead();
    }
    if (st.error) alert('Sync finished with an error: ' + st.error);
  }
}

// ---- add-album modal ----------------------------------------------------

let dialogsCache = [];

async function openAddModal() {
  if (!canUseTelegram()) {
    alert(state.status?.hasCredentials
      ? 'Not logged in. Run "npm run login" in the project folder, then reload.'
      : 'Add TG_API_ID and TG_API_HASH to your .env file, then run "npm run login".');
    return;
  }
  $('#modal').classList.remove('hidden');
  $('#dialog-search').value = '';
  const listEl = $('#dialog-list');
  listEl.innerHTML = '<div class="album-sub" style="padding:16px">Loading your chats…</div>';
  try {
    dialogsCache = await api('/api/dialogs');
    renderDialogs('');
  } catch (err) {
    listEl.innerHTML = `<div class="album-sub" style="padding:16px">Could not load chats: ${escapeHtml(err.message)}</div>`;
  }
}

function renderDialogs(filter) {
  const listEl = $('#dialog-list');
  listEl.innerHTML = '';
  const added = new Set(state.albums.map((a) => a.chat_id));
  const f = filter.trim().toLowerCase();
  const rows = dialogsCache
    .filter((d) => !f || (d.title || '').toLowerCase().includes(f) || (d.username || '').toLowerCase().includes(f));
  if (!rows.length) {
    listEl.innerHTML = '<div class="album-sub" style="padding:16px">No chats match.</div>';
    return;
  }
  for (const d of rows) {
    const row = el('div', 'dialog');
    row.append(el('div', 'd-icon', KIND_ICON[d.kind] || '📁'));
    const body = el('div', 'd-body');
    body.append(el('div', 'd-title', escapeHtml(d.title)));
    body.append(el('div', 'd-kind', d.kind));
    row.append(body);
    if (added.has(d.chatId)) {
      row.append(el('div', 'd-added', '✓ added'));
    } else {
      row.addEventListener('click', () => addAlbum(d));
    }
    listEl.append(row);
  }
}

async function addAlbum(d) {
  try {
    await api('/api/albums', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: d.chatId, title: d.title, username: d.username,
        peerType: d.peerType, accessHash: d.accessHash, kind: d.kind,
      }),
    });
    await loadAlbums();
    $('#modal').classList.add('hidden');
    await selectAlbum(d.chatId);
    startSync(d.chatId); // kick off first sync automatically
  } catch (err) {
    alert('Could not add album: ' + err.message);
  }
}

// ---- lightbox -----------------------------------------------------------

let lbIndex = -1;
let lbToken = 0;   // bumped every render; a stale async load checks it before touching the stage

function openLightbox(index) {
  lbIndex = index;
  $('#lightbox').classList.remove('hidden');
  renderLightbox();
}
function closeLightbox() {
  lbToken++;
  $('#lightbox').classList.add('hidden');
  $('#lb-stage').innerHTML = '';
  lbIndex = -1;
}
function stepLightbox(delta) {
  const next = lbIndex + delta;
  if (next < 0 || next >= state.media.length) return;
  lbIndex = next;
  renderLightbox();
  if (next >= state.media.length - 5) loadMore();
}
function renderLightbox() {
  const it = state.media[lbIndex];
  if (!it) return;
  const token = ++lbToken;
  const stage = $('#lb-stage');
  stage.innerHTML = '<div class="lb-loading">Loading… (downloading original from Telegram if not cached)</div>';
  const src = `/api/media/${it.id}/file`;
  const fail = () => { if (token === lbToken) stage.innerHTML = '<div class="lb-loading">Failed to load this item.</div>'; };
  if (IMAGE_TYPES.has(it.type)) {
    const img = el('img');
    img.addEventListener('load', () => { if (token !== lbToken) return; stage.innerHTML = ''; stage.append(img); }, { once: true });
    img.addEventListener('error', fail, { once: true });
    img.src = src;
  } else {
    const video = el('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    if (it.type === 'gif') { video.loop = true; video.muted = true; }
    video.addEventListener('loadeddata', () => { if (token !== lbToken) return; stage.innerHTML = ''; stage.append(video); }, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.src = src;
  }
  $('#lb-caption').textContent = it.caption || it.file_name || '';
  const dl = $('#lb-download');
  dl.href = `${src}?download=1`;
  dl.setAttribute('download', it.file_name || `media-${it.id}.${it.ext || 'bin'}`);
  $('#lb-prev').style.visibility = lbIndex > 0 ? 'visible' : 'hidden';
  $('#lb-next').style.visibility = lbIndex < state.media.length - 1 ? 'visible' : 'hidden';
}

// ---- wiring -------------------------------------------------------------

function wire() {
  $('#add-album').addEventListener('click', openAddModal);
  $('#modal-close').addEventListener('click', () => $('#modal').classList.add('hidden'));
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
  $('#dialog-search').addEventListener('input', (e) => renderDialogs(e.target.value));

  $('#gallery').addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (tile) openLightbox(Number(tile.dataset.index));
  });

  $('#lb-close').addEventListener('click', closeLightbox);
  $('#lb-prev').addEventListener('click', () => stepLightbox(-1));
  $('#lb-next').addEventListener('click', () => stepLightbox(1));
  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
  });

  // infinite scroll
  const io = new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting)) loadMore();
  }, { root: $('.main'), rootMargin: '600px' });
  io.observe($('#sentinel'));

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const main = $('.main');
      const ratio = main.scrollHeight ? main.scrollTop / main.scrollHeight : 0;
      renderGallery();
      main.scrollTop = ratio * main.scrollHeight; // keep viewport roughly stable across relayout
    }, 150);
  });
}

function presetMatches(album, preset) {
  const p = preset.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
  if (album.username && album.username.toLowerCase() === p.toLowerCase()) return true;
  const digits = p.replace(/[^0-9]/g, '');
  const id = String(album.chat_id);
  return !!digits && (digits === id || digits === `100${id}` || digits.endsWith(id));
}

function showWelcomeEmpty() {
  $('#empty').classList.remove('hidden');
  $('#empty').innerHTML = canUseTelegram()
    ? 'Welcome! Click <b>+ Add</b> in the sidebar to pick a Telegram chat and start syncing.'
    : (state.status?.hasCredentials
      ? 'Almost there — run <code>npm run login</code> in the project folder, then reload.'
      : 'First, add <code>TG_API_ID</code> and <code>TG_API_HASH</code> to a <code>.env</code> file (see .env.example), then run <code>npm run login</code>.');
}

async function ensurePresetAndSelect() {
  const preset = state.status?.presetGroup;
  if (preset) {
    const existing = state.albums.find((a) => presetMatches(a, preset));
    if (existing) { selectAlbum(existing.chat_id); return; }
    if (canUseTelegram()) {
      try {
        const album = await api('/api/albums/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spec: preset }),
        });
        await loadAlbums();
        selectAlbum(album.chat_id);
        startSync(album.chat_id); // first-time auto-sync of the preset group
        return;
      } catch (err) {
        $('#empty').classList.remove('hidden');
        $('#empty').innerHTML = `Couldn't open the preset group <code>${escapeHtml(preset)}</code>: ${escapeHtml(err.message)}<br>Check <code>TG_GROUP</code> in your .env, or add the chat manually with <b>+ Add</b>.`;
        return;
      }
    }
  }
  if (state.albums.length) selectAlbum(state.albums[0].chat_id);
  else showWelcomeEmpty();
}

async function main() {
  wire();
  await loadStatus();
  await loadAlbums();
  await ensurePresetAndSelect();
}

main();
