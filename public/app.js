// ---- tiny helpers -------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

function formatBytes(bytes) {
  if (!bytes) return 'Unknown size';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function api(path, opts = {}) {
  const session = localStorage.getItem('tg_session');
  opts.headers = opts.headers || {};
  if (session) {
    opts.headers['Authorization'] = `Bearer ${session}`;
  }
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

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.trim().substring(0, 2).toUpperCase();
}

function getDeterministicColor(str) {
  if (!str) return '#4f46e5';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    '#ef4444', '#f59e0b', '#10b981', '#06b6d4', 
    '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e'
  ];
  const idx = Math.abs(hash) % colors.length;
  return colors[idx];
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
  uploaders: [],      // { sender_id, sender_name, media_count } for current album
  filterSender: null, // sender_id or null for "all"
  selectionMode: false,
  selected: new Set(),
};

const IMAGE_TYPES = new Set(['photo', 'image']);

// ---- status / header ----------------------------------------------------

const PASTEL_CLASSES = ['pastel-purple', 'pastel-green', 'pastel-blue', 'pastel-orange', 'pastel-rose', 'pastel-amber'];

async function loadStatus() {
  state.status = await api('/api/status');
  const s = state.status;
  const loginOverlay = $('#login-overlay');

  if (!s.hasCredentials) {
    loginOverlay.style.display = 'none';
  } else if (!s.authenticated) {
    loginOverlay.style.display = 'flex'; // Show web login screen
  } else {
    loginOverlay.style.display = 'none'; // Hide web login screen
  }

  const name = [s.me?.firstName, s.me?.lastName].filter(Boolean).join(' ') || s.me?.username || 'TG';
  const initials = name.split(' ').map(p => p[0]).join('').substring(0, 2).toUpperCase() || 'TG';
  const initialsEl = $('#user-avatar-initials');
  if (initialsEl) initialsEl.textContent = initials;

  const badge = $('#status-badge');
  if (badge) {
    badge.className = 'status-badge';
    if (!s.hasCredentials) {
      badge.classList.add('warn');
      badge.title = 'Setup needed — add API keys to .env';
    } else if (!s.authenticated) {
      badge.classList.add('warn');
      badge.title = 'Not logged in';
    } else {
      badge.title = `Signed in as ${name}`;
    }
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
  state.albums.forEach((a, idx) => {
    const isSelected = a.chat_id === state.current;
    const pastelClass = PASTEL_CLASSES[idx % PASTEL_CLASSES.length];
    
    const card = el('div', `album-card ${pastelClass}${isSelected ? ' active' : ''}`);
    card.dataset.chatId = a.chat_id;
    
    // Card Header (Title & Uploader avatars stack)
    const headerRow = el('div', 'album-card-header');
    
    const titleCol = el('div');
    titleCol.append(el('div', 'album-card-title', escapeHtml(a.title || a.chat_id)));
    
    const syncing = state.syncTimers.has(a.chat_id);
    const mediaCountText = syncing ? 'Syncing…' : `${a.media_count} item${a.media_count === 1 ? '' : 's'}`;
    titleCol.append(el('div', 'album-card-meta', mediaCountText));
    
    headerRow.append(titleCol);
    
    // Avatar stack (uploaders)
    if (a.uploaders && a.uploaders.length > 0) {
      const stack = el('div', 'avatar-stack');
      // Render up to 3 bubbles
      const visibleUploaders = a.uploaders.slice(0, 3);
      visibleUploaders.forEach(u => {
        const initials = getInitials(u.sender_name || u.sender_id || '?');
        const bubble = el('div', 'avatar-bubble', initials);
        bubble.style.backgroundColor = getDeterministicColor(u.sender_id || u.sender_name);
        bubble.title = u.sender_name;
        stack.append(bubble);
      });
      
      if (a.uploaders.length > 3) {
        const extra = el('div', 'avatar-bubble', `+${a.uploaders.length - 3}`);
        extra.style.backgroundColor = '#64748b';
        extra.title = `${a.uploaders.length - 3} more contributors`;
        stack.append(extra);
      }
      
      headerRow.append(stack);
    }
    
    card.append(headerRow);
    
    // Horizontal thumbnail previews row
    if (a.previews && a.previews.length > 0) {
      const previewRow = el('div', 'album-card-previews');
      a.previews.forEach(p => {
        if (p.thumb_downloaded === 1) {
          const img = el('img', 'album-card-preview-img');
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          img.src = `/api/media/${p.id}/thumb?session=${encodeURIComponent(localStorage.getItem('tg_session') || '')}`;
          previewRow.append(img);
        } else {
          const pl = el('div', 'album-card-preview-placeholder', p.type === 'video' ? '🎬' : '🖼️');
          previewRow.append(pl);
        }
      });
      card.append(previewRow);
    } else {
      // Empty preview block placeholder
      const previewRow = el('div', 'album-card-previews');
      previewRow.append(el('div', 'album-card-preview-placeholder', '📁'));
      card.append(previewRow);
    }
    
    // Hover Sync button on card
    const syncBtn = el('button', 'btn-card-sync' + (syncing ? ' spinning' : ''), '↻');
    syncBtn.title = 'Sync from Telegram';
    syncBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startSync(a.chat_id, e.shiftKey);
    });
    card.append(syncBtn);
    
    card.addEventListener('click', () => selectAlbum(a.chat_id));
    list.append(card);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- select + load media ------------------------------------------------

async function selectAlbum(chatId) {
  state.gen++;              // abandon any in-flight load for the previous album
  state.loading = false;

  // Preserve lightbox state if active
  const isLightboxOpen = !$('#lightbox').classList.contains('hidden');
  const activeMediaId = isLightboxOpen && state.media[lbIndex] ? state.media[lbIndex].id : null;

  state.current = chatId;
  state.media = [];
  state.offset = 0;
  state.total = 0;
  state.uploaders = [];
  state.filterSender = null;
  state.selectionMode = false;
  state.selected.clear();
  updateSelectionUI();
  
  // Set layout active theme colors
  const a = state.albums.find(x => x.chat_id === chatId);
  if (a) {
    const idx = state.albums.indexOf(a);
    const pastelClass = PASTEL_CLASSES[idx % PASTEL_CLASSES.length];
    
    // pastel background theme values mapping to CSS vars
    const themeColors = {
      'pastel-purple': { bg: '#faf5ff', accent: '#a855f7', text: '#581c87' },
      'pastel-green':  { bg: '#f0fdf4', accent: '#22c55e', text: '#14532d' },
      'pastel-blue':   { bg: '#ecfeff', accent: '#06b6d4', text: '#164e63' },
      'pastel-orange': { bg: '#fff7ed', accent: '#f97316', text: '#7c2d12' },
      'pastel-rose':   { bg: '#fff1f2', accent: '#f43f5e', text: '#881337' },
      'pastel-amber':  { bg: '#fffbeb', accent: '#f59e0b', text: '#78350f' }
    };
    
    const theme = themeColors[pastelClass] || themeColors['pastel-purple'];
    const layoutEl = $('#app-layout');
    if (layoutEl) {
      layoutEl.style.setProperty('--active-pastel-bg', theme.bg);
      layoutEl.style.setProperty('--active-pastel-accent', theme.accent);
      layoutEl.style.setProperty('--active-pastel-text', theme.text);
    }
  }

  // Slide-in view transition on mobile
  const appLayout = $('#app-layout');
  if (appLayout) appLayout.classList.add('show-detail');

  renderSidebar();
  renderMainHead();
  $('#gallery').innerHTML = '';
  $('#empty').classList.add('hidden');
  updateHash();
  
  loadUploaders(chatId);
  await loadMore();

  // Restore lightbox state if it was open
  if (isLightboxOpen && activeMediaId !== null) {
    const newIdx = state.media.findIndex(m => m.id === activeMediaId);
    if (newIdx !== -1) {
      lbIndex = newIdx;
      renderLightbox();
      updateHash();
    } else {
      closeLightbox();
    }
  }
}

async function loadUploaders(chatId) {
  try {
    state.uploaders = await api(`/api/albums/${chatId}/uploaders`);
    renderMainHead();
  } catch { /* non-critical */ }
}

async function applyUploaderFilter(senderId) {
  state.filterSender = senderId || null;
  state.gen++;
  state.media = [];
  state.offset = 0;
  state.total = 0;
  state.loading = false;
  $('#gallery').innerHTML = '';
  $('#empty').classList.add('hidden');
  renderMainHead();
  await loadMore();
}

function renderMainHead() {
  const a = state.albums.find((x) => x.chat_id === state.current);
  if (!a) {
    $('#active-album-title').textContent = 'Select an Album';
    $('#active-album-subtitle').textContent = 'Select a chat from the sidebar to view media.';
    $('#btn-sync-album').style.display = 'none';
    $('#btn-upload-media').style.display = 'none';
    $('#btn-select-mode').style.display = 'none';
    const removeBtn = $('#btn-remove-album');
    if (removeBtn) removeBtn.style.display = 'none';
    const headerSelect = $('#header-uploader-filter');
    if (headerSelect) headerSelect.style.display = 'none';
    $('#spotlight-section').classList.add('hidden');
    return;
  }
  
  // Update header content
  $('#active-album-title').textContent = a.title || a.chat_id;
  
  const itemCount = state.total || a.media_count;
  const suffix = state.filterSender ? ' (filtered)' : '';
  $('#active-album-subtitle').textContent = `${itemCount} item${itemCount === 1 ? '' : 's'}${suffix} · ${a.downloaded_count || 0} downloaded`;
  
  // Set button display states
  const syncBtn = $('#btn-sync-album');
  const uploadBtn = $('#btn-upload-media');
  const selectBtn = $('#btn-select-mode');
  const removeBtn = $('#btn-remove-album');
  
  syncBtn.style.display = '';
  uploadBtn.style.display = '';
  selectBtn.style.display = '';
  if (removeBtn) removeBtn.style.display = '';
  
  const syncing = state.syncTimers.has(a.chat_id);
  syncBtn.textContent = syncing ? '↻ Syncing…' : '↻ Sync';
  syncBtn.disabled = syncing;
  
  selectBtn.textContent = state.selectionMode ? '✓ Done' : '☑ Select';
  selectBtn.className = 'btn-action-icon' + (state.selectionMode ? ' btn-primary' : '');
  
  // Populate header select dropdown filter
  const headerSelect = $('#header-uploader-filter');
  if (headerSelect) {
    headerSelect.innerHTML = '';
    if (state.uploaders && state.uploaders.length >= 1) {
      headerSelect.style.display = '';
      const allOpt = el('option', null, 'All contributors');
      allOpt.value = '';
      headerSelect.append(allOpt);
      for (const u of state.uploaders) {
        const opt = el('option', null, escapeHtml(`${u.sender_name || u.sender_id} (${u.media_count})`));
        opt.value = u.sender_id;
        if (u.sender_id === state.filterSender) opt.selected = true;
        headerSelect.append(opt);
      }
    } else {
      headerSelect.style.display = 'none';
    }
  }

  // Render spotlight grid
  renderSpotlightSection(a);
}

function makeCollageItem(it, idx, totalCount = 0, isLast = false) {
  const itemEl = el('div', 'collage-item');
  itemEl.style.position = 'relative';
  itemEl.style.width = '100%';
  itemEl.style.height = '100%';
  itemEl.style.cursor = 'pointer';
  itemEl.style.overflow = 'hidden';
  itemEl.dataset.index = idx;
  
  const img = el('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.src = `/api/media/${it.id}/thumb?session=${encodeURIComponent(localStorage.getItem('tg_session') || '')}`;
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = 'cover';
  img.style.transition = 'transform 0.2s ease';
  
  img.addEventListener('error', () => {
    img.remove();
    if (it.type === 'video' && it.file_downloaded === 1) {
      const v = el('video');
      v.referrerPolicy = 'no-referrer';
      v.src = `/api/media/${it.id}/file?session=${encodeURIComponent(localStorage.getItem('tg_session') || '')}#t=0.1`;
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      v.style.width = '100%';
      v.style.height = '100%';
      v.style.objectFit = 'cover';
      itemEl.prepend(v);
    } else {
      itemEl.classList.add('noimg');
      let icon = '🖼️';
      if (it.type === 'video') icon = '🎬';
      else if (it.type === 'document') icon = '📄';
      const pl = el('div', null, icon);
      pl.style.display = 'grid';
      pl.style.placeItems = 'center';
      pl.style.height = '100%';
      pl.style.color = '#94a3b8';
      pl.style.background = '#334155';
      itemEl.prepend(pl);
    }
  }, { once: true });
  
  itemEl.append(img);
  
  if (it.type === 'video') {
    const play = el('div', 'play', '<span>▶</span>');
    itemEl.append(play);
  }
  
  if (isLast && totalCount > 4) {
    const overlay = el('div', 'collage-overlay');
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(15, 23, 42, 0.6)';
    overlay.style.backdropFilter = 'blur(2px)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.color = '#ffffff';
    overlay.style.fontSize = '24px';
    overlay.style.fontWeight = '700';
    overlay.textContent = `+${totalCount - 4}`;
    itemEl.append(overlay);
  }
  
  itemEl.addEventListener('click', (e) => {
    e.stopPropagation();
    openLightbox(idx);
  });
  
  return itemEl;
}

function renderSpotlightSection(album) {
  const spotlightSection = $('#spotlight-section');
  if (!state.media.length) {
    spotlightSection.classList.add('hidden');
    return;
  }
  spotlightSection.classList.remove('hidden');
  
  // 1. Spotlight Left: Render collage inside spotlight card
  const spotlightMedia = $('#spotlight-media-card');
  spotlightMedia.innerHTML = '';
  
  const totalMedia = state.media.length;
  const itemsToUse = state.media.slice(0, Math.min(totalMedia, 4));
  
  const collageWrapper = el('div', 'spotlight-collage');
  collageWrapper.style.display = 'flex';
  collageWrapper.style.width = '100%';
  collageWrapper.style.height = '100%';
  collageWrapper.style.gap = '4px';
  collageWrapper.style.background = '#0f172a';
  
  if (itemsToUse.length === 1) {
    collageWrapper.append(makeCollageItem(itemsToUse[0], 0, totalMedia, false));
  } else if (itemsToUse.length === 2) {
    const col1 = el('div');
    col1.style.flex = '1';
    col1.style.height = '100%';
    col1.append(makeCollageItem(itemsToUse[0], 0));
    
    const col2 = el('div');
    col2.style.flex = '1';
    col2.style.height = '100%';
    col2.append(makeCollageItem(itemsToUse[1], 1));
    
    collageWrapper.append(col1, col2);
  } else if (itemsToUse.length === 3) {
    const colLeft = el('div');
    colLeft.style.flex = '1.2';
    colLeft.style.height = '100%';
    colLeft.append(makeCollageItem(itemsToUse[0], 0));
    
    const colRight = el('div');
    colRight.style.width = '40%';
    colRight.style.height = '100%';
    colRight.style.display = 'flex';
    colRight.style.flexDirection = 'column';
    colRight.style.gap = '4px';
    
    const cell1 = el('div'); cell1.style.flex = '1'; cell1.append(makeCollageItem(itemsToUse[1], 1));
    const cell2 = el('div'); cell2.style.flex = '1'; cell2.append(makeCollageItem(itemsToUse[2], 2));
    
    colRight.append(cell1, cell2);
    collageWrapper.append(colLeft, colRight);
  } else {
    // itemsToUse.length >= 4
    const colLeft = el('div');
    colLeft.style.flex = '1.4';
    colLeft.style.height = '100%';
    colLeft.append(makeCollageItem(itemsToUse[0], 0));
    
    const colRight = el('div');
    colRight.style.width = '40%';
    colRight.style.height = '100%';
    colRight.style.display = 'flex';
    colRight.style.flexDirection = 'column';
    colRight.style.gap = '4px';
    
    const cell1 = el('div'); cell1.style.flex = '1'; cell1.append(makeCollageItem(itemsToUse[1], 1));
    const cell2 = el('div'); cell2.style.flex = '1'; cell2.append(makeCollageItem(itemsToUse[2], 2));
    const cell3 = el('div'); cell3.style.flex = '1'; cell3.append(makeCollageItem(itemsToUse[3], 3, totalMedia, true));
    
    colRight.append(cell1, cell2, cell3);
    collageWrapper.append(colLeft, colRight);
  }
  
  spotlightMedia.append(collageWrapper);
  
  // 2. Stats Card
  const itemCount = state.total || album.media_count;
  $('#spotlight-stats').textContent = `${itemCount} item${itemCount === 1 ? '' : 's'}`;
  
  const syncedTimeText = album.synced_at 
    ? `Synced ${new Date(album.synced_at * 1000).toLocaleDateString()}`
    : 'Never synced';
  $('#spotlight-sync-time').textContent = syncedTimeText;
  
  // 3. Members Card (uploader avatar stack)
  const avatarStack = $('#spotlight-avatar-stack');
  avatarStack.innerHTML = '';
  const membersCountEl = $('#spotlight-members-count');
  
  if (state.uploaders && state.uploaders.length > 0) {
    const visibleUploaders = state.uploaders.slice(0, 4);
    visibleUploaders.forEach(u => {
      const initials = getInitials(u.sender_name || u.sender_id || '?');
      const bubble = el('div', 'avatar-bubble', initials);
      bubble.style.backgroundColor = getDeterministicColor(u.sender_id || u.sender_name);
      bubble.title = u.sender_name;
      avatarStack.append(bubble);
    });
    
    if (state.uploaders.length > 4) {
      membersCountEl.textContent = `+${state.uploaders.length - 4}`;
      membersCountEl.style.display = '';
    } else {
      membersCountEl.style.display = 'none';
    }
    
    // Tooltip uploader list for active filters
    const tooltipItems = $('#members-list-items');
    tooltipItems.innerHTML = '';
    
    // Add Show All row
    const allRow = el('div', 'members-list-item' + (!state.filterSender ? ' active' : ''), 'Show All');
    allRow.addEventListener('click', (e) => {
      e.stopPropagation();
      applyUploaderFilter(null);
    });
    tooltipItems.append(allRow);
    
    state.uploaders.forEach(u => {
      const row = el('div', 'members-list-item' + (state.filterSender === u.sender_id ? ' active' : ''));
      const nameEl = el('span', null, escapeHtml(u.sender_name || u.sender_id));
      const countEl = el('span', 'uploader-count', `(${u.media_count})`);
      row.append(nameEl, countEl);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        applyUploaderFilter(u.sender_id);
        
        // Hide the tooltip on item click
        const tooltip = $('#members-list-tooltip');
        if (tooltip) tooltip.classList.remove('visible');
      });
      tooltipItems.append(row);
    });
  } else {
    avatarStack.append(el('div', 'avatar-bubble', '?'));
    membersCountEl.style.display = 'none';
    $('#members-list-items').innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:4px">No contributors found.</div>';
  }
}

async function loadMore() {
  if (!state.current || state.loading) return;
  if (state.media.length && state.media.length >= state.total) return;
  const gen = state.gen;
  const chatId = state.current;
  state.loading = true;
  try {
    const senderQ = state.filterSender ? `&sender=${encodeURIComponent(state.filterSender)}` : '';
    const data = await api(`/api/albums/${chatId}/media?limit=${state.pageSize}&offset=${state.offset}${senderQ}`);
    if (gen !== state.gen) return; // album switched mid-fetch — discard this stale page
    
    state.total = data.total;
    state.offset += data.items.length;

    // Prevent duplicate entries by checking database 'id'
    const existingIds = new Set(state.media.map(m => m.id));
    const newItems = data.items.filter(m => !existingIds.has(m.id));
    state.media.push(...newItems);

    // If we loaded no items, stop further infinite scroll triggers
    if (data.items.length === 0) {
      state.total = state.media.length;
    }

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
  const main = $('.main');
  const savedScroll = main ? main.scrollTop : 0;

  gallery.innerHTML = '';
  if (!state.media.length) return;

  const containerWidth = gallery.clientWidth || (gallery.parentElement.clientWidth - 64);
  const targetH = 200;
  const gap = 8;

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

  if (main) {
    main.scrollTop = savedScroll;
  }
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
  if (state.selectionMode && state.selected.has(it.id)) {
    tile.classList.add('selected');
  }

  const chk = el('div', 'tile-checkbox', '✓');
  tile.append(chk);

  const img = el('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer'; // R2 domain blocks foreign-Referer requests
  img.src = `/api/media/${it.id}/thumb?session=${encodeURIComponent(localStorage.getItem('tg_session') || '')}`;
  img.addEventListener('error', () => {
    img.remove();
    if (it.type === 'video' && it.file_downloaded === 1) {
      const v = el('video');
      v.referrerPolicy = 'no-referrer';
      v.src = `/api/media/${it.id}/file?session=${encodeURIComponent(localStorage.getItem('tg_session') || '')}#t=0.1`;
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      v.style.width = '100%';
      v.style.height = '100%';
      v.style.objectFit = 'cover';
      tile.prepend(v);
    } else {
      tile.classList.add('noimg');
      let icon = '🖼️';
      if (it.type === 'video') icon = '🎬';
      else if (it.type === 'document') icon = '📄';
      tile.prepend(el('div', null, icon));
      if (it.type === 'document') {
        const nameEl = el('div', 'tile-doc-name', escapeHtml(it.file_name || 'Document'));
        tile.append(nameEl);
      }
    }
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

async function startSync(chatId, forceFull = false) {
  if (!canUseTelegram()) {
    alert(state.status?.hasCredentials
      ? 'Not logged in. Run "npm run login" in the project folder, then reload.'
      : 'Add TG_API_ID and TG_API_HASH to your .env file, then run "npm run login".');
    return;
  }
  if (state.syncTimers.has(chatId)) return;
  const needsFull = forceFull || (state.uploaders.length === 0 && state.media.length > 0) || state.media.some(m => !m.sender_id);
  const url = `/api/albums/${chatId}/sync${needsFull ? '?full=1' : ''}`;
  try {
    await api(url, { method: 'POST' });
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
      loadUploaders(chatId);
      const mainEl = $('.main');
      const isScrolledDown = mainEl && mainEl.scrollTop > 100;
      const isLightboxOpen = !$('#lightbox').classList.contains('hidden');
      if (isScrolledDown || isLightboxOpen) {
        renderMainHead();
        renderSidebar();
      } else {
        const keep = state.current;
        await selectAlbum(keep);
      }
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
  updateHash();
}
function closeLightbox() {
  lbToken++;
  $('#lightbox').classList.add('hidden');
  const video = $('#lb-stage video');
  if (video) {
    try {
      video.pause();
      video.src = '';
      video.load();
    } catch { /* noop */ }
  }
  $('#lb-stage').innerHTML = '';
  lbIndex = -1;
  updateHash();
}
function stepLightbox(delta) {
  const next = lbIndex + delta;
  if (next < 0 || next >= state.media.length) return;
  const video = $('#lb-stage video');
  if (video) {
    try {
      video.pause();
      video.src = '';
      video.load();
    } catch { /* noop */ }
  }
  lbIndex = next;
  renderLightbox();
  updateHash();
  if (next >= state.media.length - 5) loadMore();
}
function renderLightbox() {
  const it = state.media[lbIndex];
  if (!it) return;
  const token = ++lbToken;
  const stage = $('#lb-stage');
  const src = `/api/media/${it.id}/file?session=${encodeURIComponent(localStorage.getItem('tg_session') || '')}`;
  
  const fail = async () => {
    if (token !== lbToken) return;
    try {
      const res = await fetch(src);
      if (!res.ok) {
        const data = await res.json();
        stage.innerHTML = `<div class="lb-loading">Failed to load: ${escapeHtml(data.error || `HTTP ${res.status}`)}</div>`;
        return;
      }
    } catch { /* ignore */ }
    stage.innerHTML = '<div class="lb-loading">Failed to load this item.</div>';
  };

  if (IMAGE_TYPES.has(it.type)) {
    const img = el('img');
    img.referrerPolicy = 'no-referrer';
    img.style.display = 'none';
    stage.innerHTML = '<div class="lb-loading">Loading… (downloading original from Telegram if not cached)</div>';
    stage.append(img);
    img.addEventListener('load', () => {
      if (token !== lbToken) return;
      const loading = stage.querySelector('.lb-loading');
      if (loading) loading.remove();
      img.style.display = '';
    }, { once: true });
    img.addEventListener('error', fail, { once: true });
    img.src = src;
  } else if (it.type === 'video' || it.type === 'gif') {
    const video = el('video');
    video.referrerPolicy = 'no-referrer';
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.display = 'none';
    if (it.type === 'gif') { video.loop = true; video.muted = true; }
    stage.innerHTML = '<div class="lb-loading">Loading video… (downloading from Telegram if not cached)</div>';
    stage.append(video);
    video.addEventListener('loadeddata', () => {
      if (token !== lbToken) return;
      const loading = stage.querySelector('.lb-loading');
      if (loading) loading.remove();
      video.style.display = '';
    }, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.src = src;
  } else if (it.type === 'document') {
    if (token === lbToken) {
      const docCard = el('div', 'lb-document-card');
      docCard.innerHTML = `
        <div class="lb-doc-icon">📄</div>
        <div class="lb-doc-name">${escapeHtml(it.file_name || 'Document')}</div>
        <div class="lb-doc-size">${formatBytes(it.file_size)}</div>
      `;
      stage.innerHTML = '';
      stage.append(docCard);
    }
  }
  $('#lb-caption').textContent = it.caption || it.file_name || '';

  // Populate Uploader details
  const uploaderEl = $('#lb-uploader');
  if (uploaderEl) {
    if (it.sender_name) {
      uploaderEl.textContent = `Uploaded by: ${it.sender_name}`;
      uploaderEl.style.display = '';
    } else {
      uploaderEl.textContent = '';
      uploaderEl.style.display = 'none';
    }
  }

  const dl = $('#lb-download');
  // `src` already carries ?session=..., so append with & (a second ? would fold
  // download=1 into the session value and break both params).
  dl.href = `${src}&download=1`;
  dl.referrerPolicy = 'no-referrer';
  dl.setAttribute('download', it.file_name || `media-${it.id}.${it.ext || 'bin'}`);
  $('#lb-prev').style.visibility = lbIndex > 0 ? 'visible' : 'hidden';
  $('#lb-next').style.visibility = lbIndex < state.media.length - 1 ? 'visible' : 'hidden';
}

// ---- wiring -------------------------------------------------------------

function wire() {
  // ---- back button to exit detail on mobile ----
  const btnBack = $('#btn-back-to-albums');
  if (btnBack) {
    btnBack.addEventListener('click', () => {
      const layout = $('#app-layout');
      if (layout) layout.classList.remove('show-detail');
    });
  }

  // ---- remove album button ----
  const btnRemove = $('#btn-remove-album');
  if (btnRemove) {
    btnRemove.addEventListener('click', async () => {
      const chatId = state.current;
      if (!chatId) return;
      
      const a = state.albums.find(x => x.chat_id === chatId);
      const title = a ? (a.title || chatId) : chatId;
      
      if (!confirm(`Are you sure you want to remove the album "${title}"? This will delete all synced media from the database.`)) {
        return;
      }
      
      btnRemove.disabled = true;
      btnRemove.textContent = 'Removing…';
      try {
        await api(`/api/albums/${chatId}`, { method: 'DELETE' });
        // Deselect current
        state.current = null;
        state.media = [];
        state.offset = 0;
        state.total = 0;
        
        // Reload albums and select first
        await loadAlbums();
        await ensurePresetAndSelect();
      } catch (err) {
        alert('Failed to remove album: ' + err.message);
      } finally {
        btnRemove.disabled = false;
        btnRemove.textContent = '🗑️ Remove';
      }
    });
  }

  // ---- main header buttons ----
  const btnSync = $('#btn-sync-album');
  if (btnSync) {
    btnSync.addEventListener('click', (e) => {
      if (state.current) startSync(state.current, e.shiftKey);
    });
  }
  const btnUpload = $('#btn-upload-media');
  if (btnUpload) {
    btnUpload.addEventListener('click', () => {
      $('#upload-input').click();
    });
  }
  const btnSelect = $('#btn-select-mode');
  if (btnSelect) {
    btnSelect.addEventListener('click', () => {
      state.selectionMode = !state.selectionMode;
      if (!state.selectionMode) state.selected.clear();
      updateSelectionUI();
      renderMainHead();
    });
  }

  // ---- spotlight add card upload hook ----
  const addCard = $('#spotlight-upload-card');
  if (addCard) {
    addCard.addEventListener('click', () => {
      $('#upload-input').click();
    });
  }

  // ---- spotlight spotlight card click to lightbox ----
  const spotlightMediaCard = $('#spotlight-media-card');
  if (spotlightMediaCard) {
    spotlightMediaCard.addEventListener('click', () => {
      if (state.media.length > 0) openLightbox(0);
    });
  }

  // ---- header select uploader filter change hook ----
  const headerSelect = $('#header-uploader-filter');
  if (headerSelect) {
    headerSelect.addEventListener('change', () => {
      applyUploaderFilter(headerSelect.value);
    });
  }

  // ---- members card click toggle tooltip ----
  const membersCard = $('#spotlight-members-card');
  const tooltip = $('#members-list-tooltip');
  if (membersCard && tooltip) {
    membersCard.addEventListener('click', (e) => {
      e.stopPropagation();
      tooltip.classList.toggle('visible');
    });
    tooltip.addEventListener('click', (e) => {
      e.stopPropagation(); // don't close tooltip when clicking inside it
    });
  }
  // Close tooltip when clicking anywhere else
  document.addEventListener('click', () => {
    const tooltip = $('#members-list-tooltip');
    if (tooltip) tooltip.classList.remove('visible');
  });

  // Create hidden file input for upload
  const uploadInput = el('input');
  uploadInput.type = 'file';
  uploadInput.multiple = true;
  uploadInput.id = 'upload-input';
  uploadInput.style.display = 'none';
  uploadInput.addEventListener('change', handleUpload);
  document.body.append(uploadInput);

  // Create selection bar
  const bar = el('div', 'selection-bar hidden');
  bar.id = 'selection-bar';
  bar.innerHTML = `
    <span id="selection-count">0 items selected</span>
    <button class="btn-selection btn-selection-primary" id="btn-download-selected">Download Selected</button>
    <button class="btn-selection" id="btn-clear-selection">Cancel</button>
  `;
  document.body.append(bar);

  $('#btn-download-selected').addEventListener('click', downloadSelected);
  $('#btn-clear-selection').addEventListener('click', () => {
    state.selected.clear();
    document.querySelectorAll('.tile.selected').forEach((t) => t.classList.remove('selected'));
    updateSelectionUI();
  });

  $('#add-album').addEventListener('click', openAddModal);
  $('#modal-close').addEventListener('click', () => $('#modal').classList.add('hidden'));
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
  $('#dialog-search').addEventListener('input', (e) => renderDialogs(e.target.value));

  $('#gallery').addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const idx = Number(tile.dataset.index);
    const it = state.media[idx];
    if (!it) return;

    if (state.selectionMode) {
      if (state.selected.has(it.id)) {
        state.selected.delete(it.id);
        tile.classList.remove('selected');
      } else {
        state.selected.add(it.id);
        tile.classList.add('selected');
      }
      updateSelectionUI();
    } else {
      openLightbox(idx);
    }
  });

  $('#lb-close').addEventListener('click', closeLightbox);
  $('#lb-prev').addEventListener('click', () => stepLightbox(-1));
  $('#lb-next').addEventListener('click', () => stepLightbox(1));
  $('#lb-share').addEventListener('click', () => {
    const shareUrl = window.location.href;
    
    const copyToClipboard = (text) => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
      // Fallback for insecure contexts (HTTP IP, etc.)
      return new Promise((resolve, reject) => {
        try {
          const textArea = document.createElement('textarea');
          textArea.value = text;
          textArea.style.top = '0';
          textArea.style.left = '0';
          textArea.style.position = 'fixed';
          textArea.style.opacity = '0';
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          const successful = document.execCommand('copy');
          document.body.removeChild(textArea);
          if (successful) {
            resolve();
          } else {
            reject(new Error('execCommand copy failed'));
          }
        } catch (err) {
          reject(err);
        }
      });
    };

    copyToClipboard(shareUrl).then(() => {
      const shareBtn = $('#lb-share');
      const oldText = shareBtn.innerHTML;
      shareBtn.innerHTML = '✓ Copied!';
      shareBtn.style.color = '#3fb950';
      setTimeout(() => {
        shareBtn.innerHTML = oldText;
        shareBtn.style.color = '';
      }, 1500);
    }).catch(err => {
      alert('Failed to copy link: ' + err.message);
    });
  });
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
  // Web Login Flow wiring
  let loginId = null;

  $('#login-send').addEventListener('click', async () => {
    const phone = $('#login-phone').value.trim();
    if (!phone) {
      showLoginError('Please enter your phone number.');
      return;
    }
    hideLoginError();
    $('#login-send').disabled = true;
    $('#login-send').textContent = 'Sending…';
    try {
      const res = await api('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone }),
      });
      loginId = res.loginId;
      $('#login-step-phone').style.display = 'none';
      $('#login-step-code').style.display = 'block';
    } catch (err) {
      showLoginError(err.message);
    } finally {
      $('#login-send').disabled = false;
      $('#login-send').textContent = 'Send Code';
    }
  });

  $('#login-submit').addEventListener('click', async () => {
    const code = $('#login-code').value.trim();
    const password = $('#login-2fa').value.trim();
    if (!code) {
      showLoginError('Please enter the verification code.');
      return;
    }
    hideLoginError();
    $('#login-submit').disabled = true;
    $('#login-submit').textContent = 'Verifying…';
    try {
      const res = await api('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId, code, password }),
      });
      localStorage.setItem('tg_session', res.session);
      $('#login-overlay').style.display = 'none';
      $('#login-phone').value = '';
      $('#login-code').value = '';
      $('#login-2fa').value = '';
      $('#login-step-phone').style.display = 'block';
      $('#login-step-code').style.display = 'none';

      await loadStatus();
      await loadAlbums();
      await ensurePresetAndSelect();
    } catch (err) {
      showLoginError(err.message);
    } finally {
      $('#login-submit').disabled = false;
      $('#login-submit').textContent = 'Log In';
    }
  });

  $('#login-back').addEventListener('click', () => {
    hideLoginError();
    loginId = null;
    $('#login-step-phone').style.display = 'block';
    $('#login-step-code').style.display = 'none';
  });

  function showLoginError(msg) {
    const err = $('#login-error');
    err.textContent = msg;
    err.style.display = 'block';
  }
  function hideLoginError() {
    $('#login-error').style.display = 'none';
  }
}

function updateSelectionUI() {
  const gallery = $('#gallery');
  if (state.selectionMode) {
    gallery.classList.add('selection-mode');
  } else {
    gallery.classList.remove('selection-mode');
    document.querySelectorAll('.tile.selected').forEach((t) => t.classList.remove('selected'));
  }
  const bar = $('#selection-bar');
  if (state.selectionMode && state.selected.size > 0) {
    $('#selection-count').textContent = `${state.selected.size} item${state.selected.size === 1 ? '' : 's'} selected`;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

async function downloadSelected() {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  const dlBtn = $('#btn-download-selected');
  const prevText = dlBtn.textContent;
  dlBtn.textContent = 'Zipping…';
  dlBtn.disabled = true;
  try {
    const session = localStorage.getItem('tg_session');
    const headers = { 'Content-Type': 'application/json' };
    if (session) headers['Authorization'] = `Bearer ${session}`;
    const res = await fetch('/api/media/download-zip', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gallery-download.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    state.selected.clear();
    state.selectionMode = false;
    updateSelectionUI();
    renderMainHead();
  } catch (err) {
    alert('ZIP download failed: ' + err.message);
  } finally {
    dlBtn.textContent = prevText;
    dlBtn.disabled = false;
  }
}

async function handleUpload(e) {
  const files = Array.from(e.target.files);
  if (!files || !files.length) return;
  const chatId = state.current;
  if (!chatId) return;

  const uploadBtn = $('#btn-upload-media');
  const prevText = uploadBtn ? uploadBtn.textContent : 'Upload';
  if (uploadBtn) {
    uploadBtn.textContent = 'Uploading…';
    uploadBtn.disabled = true;
  }

  try {
    const fileMeta = files.map(f => ({ name: f.name, mime: f.type || 'application/octet-stream' }));
    const { urls } = await api(`/api/albums/${chatId}/upload-urls?files=${encodeURIComponent(JSON.stringify(fileMeta))}`);

    const uploads = [];
    for (const u of urls) {
      const file = files.find(f => f.name === u.originalName);
      if (!file) continue;

      const putRes = await fetch(u.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': u.mime,
        },
      });

      if (!putRes.ok) {
        throw new Error(`Failed to upload ${u.originalName} to cloud storage (HTTP ${putRes.status})`);
      }

      uploads.push({
        r2Key: u.r2Key,
        mime: u.mime,
        originalName: u.originalName,
      });
    }

    const confirmRes = await api(`/api/albums/${chatId}/upload-confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploads }),
    });

    alert(`Successfully uploaded ${confirmRes.added.length} file(s) to Telegram!`);
    e.target.value = '';
    await selectAlbum(chatId);
  } catch (err) {
    alert('Upload failed: ' + err.message);
  } finally {
    if (uploadBtn) {
      uploadBtn.textContent = prevText;
      uploadBtn.disabled = false;
    }
  }
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

let currentHashStr = '';

function parseHash() {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  return {
    album: params.get('album') || null,
    media: params.get('media') || null,
  };
}

function updateHash() {
  let newHash = '';
  if (state.current) {
    newHash = `album=${state.current}`;
    const isLightboxOpen = !$('#lightbox').classList.contains('hidden');
    if (isLightboxOpen && state.media[lbIndex]) {
      newHash += `&media=${state.media[lbIndex].id}`;
    }
  }
  if (window.location.hash !== `#${newHash}`) {
    currentHashStr = `#${newHash}`;
    window.location.hash = newHash;
  }
}

async function handleHashChange() {
  if (window.location.hash === currentHashStr) return;
  currentHashStr = window.location.hash;

  const parsed = parseHash();
  if (!parsed.album) return;
  if (!canUseTelegram()) return;

  const albumExists = state.albums.some(a => a.chat_id === parsed.album);
  if (!albumExists) return;

  if (state.current !== parsed.album) {
    await selectAlbum(parsed.album);
  }

  if (parsed.media) {
    let idx = state.media.findIndex(m => String(m.id) === String(parsed.media));
    if (idx === -1) {
      try {
        const item = await api(`/api/media/${parsed.media}`);
        if (String(item.chat_id) === String(parsed.album)) {
          state.media.unshift(item);
          renderGallery();
          idx = 0;
        }
      } catch (err) {
        console.error('Failed to load shared media:', err);
      }
    }
    if (idx !== -1) {
      openLightbox(idx);
    }
  } else {
    closeLightbox();
  }
}

window.addEventListener('hashchange', handleHashChange);

async function ensurePresetAndSelect() {
  const parsed = parseHash();
  if (parsed.album && state.albums.some(a => a.chat_id === parsed.album)) {
    currentHashStr = window.location.hash;
    await selectAlbum(parsed.album);
    if (parsed.media) {
      let idx = state.media.findIndex(m => String(m.id) === String(parsed.media));
      if (idx === -1) {
        try {
          const item = await api(`/api/media/${parsed.media}`);
          if (String(item.chat_id) === String(parsed.album)) {
            state.media.unshift(item);
            renderGallery();
            idx = 0;
          }
        } catch (err) {
          console.error('Failed to load shared media:', err);
        }
      }
      if (idx !== -1) {
        openLightbox(idx);
      }
    }
    return;
  }

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
  // Only load gallery data if user is authenticated
  if (canUseTelegram()) {
    await loadAlbums();
    await ensurePresetAndSelect();
  }
}

main();
