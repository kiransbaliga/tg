import fs from 'node:fs';
import express from 'express';
import { PORT, HOST, GROUP, PUBLIC_DIR, hasCredentials } from './config.js';
import * as store from './db.js';
import {
  getClient, getMe, listDialogs, resolveEntity, buildInputPeer,
  ensureFullDownload, downloadThumbToDisk,
  thumbPathForRow, mediaPathForRow,
} from './telegram.js';
import { syncAlbum, getSyncStatus } from './sync.js';

const app = express();
app.use(express.json());

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function clientError(err) {
  if (err?.message === 'NO_CREDENTIALS') {
    return { status: 428, error: 'Missing API credentials. Add TG_API_ID and TG_API_HASH to your .env file.' };
  }
  if (err?.message === 'NOT_AUTHORIZED') {
    return { status: 401, error: 'Not logged in to Telegram. Run: npm run login' };
  }
  return { status: 500, error: err?.message || 'Server error' };
}

// ---- status -------------------------------------------------------------

app.get('/api/status', asyncH(async (req, res) => {
  const creds = hasCredentials();
  const base = { hasCredentials: creds, presetGroup: GROUP || null };
  if (!creds) return res.json({ ...base, authenticated: false, me: null });
  try {
    const me = await getMe();
    res.json({ ...base, authenticated: true, me });
  } catch (err) {
    res.json({ ...base, authenticated: false, me: null, reason: err?.message || null });
  }
}));

// ---- dialogs (pick which chats to add as albums) ------------------------

app.get('/api/dialogs', asyncH(async (req, res) => {
  try {
    res.json(await listDialogs());
  } catch (err) {
    const e = clientError(err);
    res.status(e.status).json({ error: e.error });
  }
}));

// ---- albums -------------------------------------------------------------

app.get('/api/albums', (req, res) => {
  res.json(store.listAlbums());
});

app.post('/api/albums', (req, res) => {
  const { chatId, title, username, peerType, accessHash, kind } = req.body || {};
  if (!chatId) return res.status(400).json({ error: 'chatId is required' });
  const album = store.upsertAlbum({ chatId, title, username, peerType, accessHash, kind });
  res.json(album);
});

// Resolve a chat by @username / t.me link / id and add it as an album.
// Used to open the preset TG_GROUP on startup (and to add by pasted handle).
app.post('/api/albums/resolve', asyncH(async (req, res) => {
  const spec = ((req.body?.spec ?? '') || GROUP).toString().trim();
  if (!spec) return res.status(400).json({ error: 'No group specified' });
  try {
    const album = store.upsertAlbum(await resolveEntity(spec));
    res.json(album);
  } catch (err) {
    if (/could not find|cannot find|no user|USERNAME_(NOT_OCCUPIED|INVALID)|Cannot cast/i.test(err?.message || '')) {
      return res.status(404).json({ error: `Could not find "${spec}". Use an @username, a t.me link, or the numeric id of a chat you're a member of.` });
    }
    const e = clientError(err);
    res.status(e.status).json({ error: e.error });
  }
}));

app.delete('/api/albums/:chatId', (req, res) => {
  store.deleteAlbum(req.params.chatId);
  res.json({ ok: true });
});

app.post('/api/albums/:chatId/sync', asyncH(async (req, res) => {
  try {
    const status = syncAlbum(req.params.chatId);
    res.json(status);
  } catch (err) {
    if (err?.message === 'ALBUM_NOT_FOUND') return res.status(404).json({ error: 'Album not found' });
    const e = clientError(err);
    res.status(e.status).json({ error: e.error });
  }
}));

app.get('/api/albums/:chatId/sync/status', (req, res) => {
  res.json(getSyncStatus(req.params.chatId) || { running: false, done: false });
});

app.get('/api/albums/:chatId/media', (req, res) => {
  const chatId = req.params.chatId;
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 1000);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  const items = store.listMedia(chatId, limit, offset);
  const total = store.countMedia(chatId);
  res.json({ items, total, limit, offset });
});

// ---- media bytes --------------------------------------------------------

app.get('/api/media/:id/thumb', asyncH(async (req, res) => {
  const row = store.getMediaById(req.params.id);
  if (!row) return res.status(404).end();
  const thumbPath = thumbPathForRow(row);
  res.set('Cache-Control', 'public, max-age=86400');
  if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath);

  // Lazy fallback: fetch the message and pull its thumbnail on demand.
  try {
    const client = await getClient();
    const peer = buildInputPeer(store.getAlbum(row.chat_id));
    const messages = await client.getMessages(peer, { ids: [Number(row.message_id)] });
    const message = messages && messages[0];
    if (message && await downloadThumbToDisk(client, message, row.chat_id, row.message_id)) {
      store.markThumbByKey(row.chat_id, row.message_id);
      if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath);
    }
  } catch { /* fall through to 404 */ }
  res.status(404).end();
}));

app.get('/api/media/:id/file', asyncH(async (req, res) => {
  const row = store.getMediaById(req.params.id);
  if (!row) return res.status(404).end();
  const filePath = mediaPathForRow(row);
  try {
    if (!fs.existsSync(filePath)) await ensureFullDownload(row);
  } catch (err) {
    const e = clientError(err);
    return res.status(e.status).json({ error: e.error });
  }
  if (!fs.existsSync(filePath)) return res.status(404).end();

  if (row.mime) res.type(row.mime);
  if (req.query.download === '1') {
    const name = row.file_name || `${row.type || 'media'}-${row.message_id}.${row.ext || 'bin'}`;
    return res.download(filePath, name);
  }
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(filePath); // send() adds Range/206 support for video seeking
}));

// ---- static frontend ----------------------------------------------------

app.use(express.static(PUBLIC_DIR));

// error handler (Express 5 forwards async rejections here)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const e = clientError(err);
  res.status(e.status).json({ error: e.error });
});

app.listen(PORT, HOST, () => {
  console.log(`\n  TG Gallery running at  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  if (!hasCredentials()) {
    console.log('  ⚠  No API credentials yet. Copy .env.example to .env and fill it in, then run: npm run login\n');
  }
});
