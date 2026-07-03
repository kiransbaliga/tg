import fs from 'node:fs';
import path from 'node:path';
import bigInt from 'big-integer';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import {
  API_ID, API_HASH, MEDIA_DIR, THUMBS_DIR,
  hasCredentials, loadSession,
} from './config.js';
import { getAlbum, markFileByKey } from './db.js';

// ---- shared client singleton -------------------------------------------

let clientPromise = null;

export async function getClient() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    if (!hasCredentials()) throw new Error('NO_CREDENTIALS');
    const session = new StringSession(loadSession());
    const client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 5,
      floodSleepThreshold: 60,
      autoReconnect: true,
    });
    try { client.setLogLevel?.('error'); } catch { /* noop */ }
    try { client.logger?.setLevel?.('error'); } catch { /* noop */ }
    await client.connect();
    if (!(await client.isUserAuthorized())) throw new Error('NOT_AUTHORIZED');
    return client;
  })();
  try {
    return await clientPromise;
  } catch (err) {
    clientPromise = null; // allow a later retry once creds/session are fixed
    throw err;
  }
}

export async function getMe() {
  const client = await getClient();
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

/**
 * Resolve a chat spec (@username, t.me link, or numeric id) into the fields we
 * store as an album. For numeric ids we first warm the dialog cache so GramJS
 * can turn the id into an input entity.
 */
export async function resolveEntity(spec) {
  const client = await getClient();
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

export async function listDialogs(limit = 300) {
  const client = await getClient();
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

/**
 * Normalise a message's media into a flat record, or null if it carries no
 * downloadable photo/video. Handles both compressed photos and "send as file"
 * documents (the user's case: photos/videos delivered as documents).
 */
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

// ---- sender extraction --------------------------------------------------

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

/**
 * Pick the thumbnail SIZE OBJECT best suited for a grid tile. We return the
 * object itself (not an index) and pass it straight to downloadMedia({thumb}).
 * GramJS's getThumb() re-sorts the size array and drops PhotoPathSize before
 * applying a numeric index, so a raw index addresses the wrong element — and
 * for documents an out-of-range index silently downloads the whole original.
 * Passing the object sidesteps all of that (getThumb returns it directly).
 */
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

// ---- on-disk paths ------------------------------------------------------

const sanitizeSeg = (s) => (String(s).replace(/[^0-9]/g, '') || '0');
const sanitizeExt = (e) => (String(e || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin');

export function thumbPathForParts(chatId, messageId) {
  return path.join(THUMBS_DIR, sanitizeSeg(chatId), `${Number(messageId)}.jpg`);
}
export function thumbPathForRow(row) {
  return thumbPathForParts(row.chat_id, row.message_id);
}
export function mediaPathForRow(row) {
  return path.join(MEDIA_DIR, sanitizeSeg(row.chat_id), `${Number(row.message_id)}.${sanitizeExt(row.ext)}`);
}

export async function downloadThumbToDisk(client, message, chatId, messageId) {
  const size = chooseThumb(message.media);
  if (!size) return false;
  const buf = await client.downloadMedia(message, { thumb: size });
  if (!buf || !buf.length) return false;
  const dest = thumbPathForParts(chatId, messageId);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return true;
}

// ---- full-file download (lazy, de-duplicated) ---------------------------

// Cap concurrent full-file downloads so browsing many uncached items (or a
// browser firing lots of range requests) can't spawn unbounded parallel pulls
// and trip a Telegram flood-wait.
const MAX_CONCURRENT_DOWNLOADS = 3;
let activeDownloads = 0;
const downloadWaiters = [];

function acquireDownloadSlot() {
  if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) { activeDownloads++; return Promise.resolve(); }
  return new Promise((resolve) => downloadWaiters.push(resolve));
}
function releaseDownloadSlot() {
  const next = downloadWaiters.shift();
  if (next) next();          // hand the slot directly to a waiter (count unchanged)
  else activeDownloads--;
}

const inflight = new Map();

export function ensureFullDownload(row) {
  const key = `${row.chat_id}:${row.message_id}`;
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    const client = await getClient();
    const peer = buildInputPeer(getAlbum(row.chat_id));
    const messages = await client.getMessages(peer, { ids: [Number(row.message_id)] });
    const message = messages && messages[0];
    if (!message || !message.media) throw new Error('MESSAGE_NOT_FOUND');
    const dest = mediaPathForRow(row);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    await acquireDownloadSlot();
    try {
      await client.downloadMedia(message, { outputFile: tmp });
    } catch (err) {
      fs.rmSync(tmp, { force: true }); // never leave a partial file behind
      throw err;
    } finally {
      releaseDownloadSlot();
    }
    fs.renameSync(tmp, dest);
    markFileByKey(row.chat_id, row.message_id);
    return dest;
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
