import fs from 'node:fs';
import path from 'node:path';
import bigInt from 'big-integer';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { API_ID, API_HASH, hasCredentials } from './config.js';
import { getAlbum, markFileByKey } from './db.js';
import { uploadToR2 } from './r2.js';

// ---- shared client creator -------------------------------------------

export async function getClient(sessionString) {
  if (!sessionString) throw new Error('NO_SESSION');
  if (!hasCredentials()) throw new Error('NO_CREDENTIALS');
  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
    autoReconnect: true,
  });
  try { client.setLogLevel?.('error'); } catch { /* noop */ }
  try { client.logger?.setLevel?.('error'); } catch { /* noop */ }
  await client.connect();
  return client;
}

export async function getMe(client) {
  const me = await client.getMe();
  return {
    id: me.id?.toString?.() ?? String(me.id),
    firstName: me.firstName || '',
    lastName: me.lastName || '',
    username: me.username || null,
    phone: me.phone || null,
  };
}

// ---- entity / peer helpers ---------------------------------------------

function peerTypeOf(entity) {
  const cn = entity.className;
  if (cn === 'User') return 'user';
  if (cn === 'Chat' || cn === 'ChatForbidden') return 'chat';
  return 'channel'; // Channel / ChannelForbidden
}

function kindOf(entity) {
  const cn = entity.className;
  if (cn === 'User') return entity.bot ? 'bot' : 'user';
  if (cn === 'Chat' || cn === 'ChatForbidden') return 'group';
  return entity.megagroup ? 'supergroup' : 'channel';
}

export function buildInputPeer(album) {
  if (!album) throw new Error('ALBUM_NOT_FOUND');
  const id = bigInt(String(album.chat_id));
  const hash = album.access_hash ? bigInt(String(album.access_hash)) : bigInt(0);
  switch (album.peer_type) {
    case 'user': return new Api.InputPeerUser({ userId: id, accessHash: hash });
    case 'chat': return new Api.InputPeerChat({ chatId: id });
    default: return new Api.InputPeerChannel({ channelId: id, accessHash: hash });
  }
}

export async function resolveEntity(client, spec) {
  const raw = String(spec).trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^\/+/, '');
  let arg = raw;
  if (/^-?\d+$/.test(raw)) {
    try { await client.getDialogs({ limit: 500 }); } catch { /* warm entity cache */ }
    arg = bigInt(raw);
  }
  const e = await client.getEntity(arg);
  const title = e.title
    || [e.firstName, e.lastName].filter(Boolean).join(' ')
    || e.username
    || raw;
  return {
    chatId: e.id.toString(),
    title,
    username: e.username || null,
    peerType: peerTypeOf(e),
    kind: kindOf(e),
    accessHash: e.accessHash ? e.accessHash.toString() : null,
  };
}

export async function listDialogs(client, limit = 300) {
  const dialogs = await client.getDialogs({ limit });
  const out = [];
  for (const d of dialogs) {
    const e = d.entity;
    if (!e || !e.id) continue;
    const title = d.title
      || e.title
      || [e.firstName, e.lastName].filter(Boolean).join(' ')
      || e.username
      || 'Unknown';
    out.push({
      chatId: e.id.toString(),
      title,
      username: e.username || null,
      peerType: peerTypeOf(e),
      kind: kindOf(e),
      accessHash: e.accessHash ? e.accessHash.toString() : null,
    });
  }
  return out;
}

// ---- media metadata extraction -----------------------------------------

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff',
  'image/bmp': 'bmp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi',
};

function extFromName(name) {
  if (!name) return null;
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : null;
}

function extFromMime(mime) {
  if (!mime) return null;
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const tail = mime.split('/')[1];
  return tail ? tail.replace(/[^a-z0-9]/gi, '').toLowerCase() : null;
}

export function extractMedia(message) {
  const media = message?.media;
  if (!media) return null;
  const cn = media.className;

  if (cn === 'MessageMediaPhoto' || media.photo) {
    const photo = media.photo;
    if (!photo) return null;
    let width = null, height = null;
    for (const s of photo.sizes || []) {
      if (s.w && (width === null || s.w > width)) { width = s.w; height = s.h; }
    }
    return { type: 'photo', mime: 'image/jpeg', ext: 'jpg', width, height, duration: null, fileSize: null, fileName: null };
  }

  if (cn === 'MessageMediaDocument' || media.document) {
    const doc = media.document;
    if (!doc) return null;
    const mime = doc.mimeType || 'application/octet-stream';
    let fileName = null, width = null, height = null, duration = null;
    let isVideo = false, isGif = false;
    for (const attr of doc.attributes || []) {
      switch (attr.className) {
        case 'DocumentAttributeFilename': fileName = attr.fileName; break;
        case 'DocumentAttributeVideo': isVideo = true; width = attr.w; height = attr.h; duration = attr.duration; break;
        case 'DocumentAttributeImageSize': width = attr.w; height = attr.h; break;
        case 'DocumentAttributeAnimated': isGif = true; break;
        default: break;
      }
    }
    const isImage = mime.startsWith('image/');
    const isVideoMime = mime.startsWith('video/');
    let type = 'document';
    if (isVideo || isVideoMime) type = 'video';
    else if (isGif) type = 'gif';
    else if (isImage) type = 'image';

    const ext = extFromName(fileName) || extFromMime(mime) || 'bin';
    let size = null;
    try { size = doc.size != null ? Number(doc.size) : null; } catch { size = null; }
    return { type, mime, ext, width, height, duration, fileSize: size, fileName };
  }

  return null;
}

export function extractSender(message) {
  const senderId = message.senderId?.toString?.() ?? (message.fromId?.userId ?? message.fromId?.channelId ?? message.fromId?.chatId)?.toString?.() ?? null;
  let name = null;
  const s = message._sender || message.sender;
  if (s) {
    name = s.title || [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username || null;
  }
  return { id: senderId, name };
}

// ---- thumbnails ---------------------------------------------------------

function chooseThumb(media) {
  const sizes = media?.document?.thumbs || media?.photo?.sizes || [];
  if (!sizes.length) return null;
  const TARGET = 360;
  const real = [];
  let stripped = null;
  for (const s of sizes) {
    if (s.className === 'PhotoStrippedSize') { if (!stripped) stripped = s; continue; }
    if (s.className === 'PhotoPathSize') continue; // vector outline, unusable as raster
    real.push(s);
  }
  if (!real.length) return stripped; // only a tiny inline placeholder is available
  real.sort((a, b) => (a.w || 0) - (b.w || 0));
  for (const s of real) if ((s.w || 0) >= TARGET) return s;
  return real[real.length - 1];
}

export async function downloadThumbToR2(client, message, chatId, messageId) {
  const size = chooseThumb(message.media);
  if (!size) return false;
  const buf = await client.downloadMedia(message, { thumb: size });
  if (!buf || !buf.length) return false;
  const r2Key = `thumbs/${chatId}/${messageId}.jpg`;
  await uploadToR2(r2Key, buf, 'image/jpeg');
  return true;
}

// ---- full-file download (lazy, de-duplicated) ---------------------------

const MAX_CONCURRENT_DOWNLOADS = 3;
let activeDownloads = 0;
const downloadWaiters = [];

function acquireDownloadSlot() {
  if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) { activeDownloads++; return Promise.resolve(); }
  return new Promise((resolve) => downloadWaiters.push(resolve));
}
function releaseDownloadSlot() {
  const next = downloadWaiters.shift();
  if (next) next();
  else activeDownloads--;
}

const inflight = new Map();

export function ensureFullDownload(client, row) {
  const key = `${row.chat_id}:${row.message_id}`;
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    const peer = buildInputPeer(await getAlbum(row.chat_id));
    const messages = await client.getMessages(peer, { ids: [Number(row.message_id)] });
    const message = messages && messages[0];
    if (!message || !message.media) throw new Error('MESSAGE_NOT_FOUND');
    
    await acquireDownloadSlot();
    try {
      const buf = await client.downloadMedia(message);
      if (!buf) throw new Error('DOWNLOAD_FAILED');
      const r2Key = `media/${row.chat_id}/${row.message_id}.${row.ext || 'bin'}`;
      await uploadToR2(r2Key, buf, row.mime || 'application/octet-stream');
    } finally {
      releaseDownloadSlot();
    }
    await markFileByKey(row.chat_id, row.message_id);
    return true;
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
