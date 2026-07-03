import fs from 'node:fs';
import path from 'node:path';
import heicConvert from 'heic-convert';
import express from 'express';
import multer from 'multer';
import { ZipArchive } from 'archiver';
import { PORT, HOST, GROUP, PUBLIC_DIR, hasCredentials, DATA_DIR } from './config.js';
import * as store from './db.js';
import {
  getClient, getMe, listDialogs, resolveEntity, buildInputPeer,
  ensureFullDownload, downloadThumbToDisk, extractMedia, extractSender,
  thumbPathForRow, mediaPathForRow,
} from './telegram.js';
import { syncAlbum, getSyncStatus } from './sync.js';

const app = express();
app.use(express.json());

const uploadDir = path.join(DATA_DIR, 'temp');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

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
    if (req.query.full === '1') store.resetAlbumSync(req.params.chatId);
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

app.get('/api/albums/:chatId/uploaders', (req, res) => {
  res.json(store.listUploaders(req.params.chatId));
});

app.get('/api/albums/:chatId/media', (req, res) => {
  const chatId = req.params.chatId;
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 1000);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  const senderId = req.query.sender || null;
  const items = store.listMedia(chatId, limit, offset, senderId);
  const total = store.countMedia(chatId, senderId);
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

  const isDownload = req.query.download === '1';
  const isHeic = row.ext?.toLowerCase() === 'heic' || row.ext?.toLowerCase() === 'heif';

  if (isHeic && !isDownload) {
    const convertedPath = filePath + '.jpg';
    if (!fs.existsSync(convertedPath)) {
      try {
        const inputBuffer = fs.readFileSync(filePath);
        const outputBuffer = await heicConvert({
          buffer: inputBuffer,
          format: 'JPEG',
          quality: 0.9,
        });
        fs.writeFileSync(convertedPath, outputBuffer);
      } catch (err) {
        console.error(`Failed to convert HEIC file ${filePath} to JPEG:`, err);
        // Fallback to original file
      }
    }
    if (fs.existsSync(convertedPath)) {
      res.type('image/jpeg');
      res.set('Cache-Control', 'private, max-age=3600');
      return res.sendFile(convertedPath);
    }
  }

  if (row.mime) res.type(row.mime);
  if (isDownload) {
    const name = row.file_name || `${row.type || 'media'}-${row.message_id}.${row.ext || 'bin'}`;
    return res.download(filePath, name);
  }
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(filePath); // send() adds Range/206 support for video seeking
}));

app.post('/api/albums/:chatId/upload', upload.array('files'), asyncH(async (req, res) => {
  const chatId = req.params.chatId;
  const album = store.getAlbum(chatId);
  if (!album) return res.status(404).json({ error: 'Album not found' });
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const results = [];
  const client = await getClient();
  const peer = buildInputPeer(album);

  for (const file of req.files) {
    let uploadPath = file.path;
    const tempSubdir = path.join(uploadDir, `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`);
    try {
      fs.mkdirSync(tempSubdir, { recursive: true });
      const finalUploadPath = path.join(tempSubdir, file.originalname);
      fs.renameSync(file.path, finalUploadPath);
      uploadPath = finalUploadPath;

      const message = await client.sendFile(peer, {
        file: uploadPath,
        caption: file.originalname,
        forceDocument: true,
      });

      const meta = extractMedia(message);
      if (meta) {
        const sender = extractSender(message);
        store.insertMedia({
          chatId,
          messageId: message.id,
          groupedId: message.groupedId ? message.groupedId.toString() : null,
          type: meta.type,
          mime: meta.mime,
          fileName: meta.fileName || file.originalname,
          fileSize: meta.fileSize || file.size,
          width: meta.width,
          height: meta.height,
          duration: meta.duration,
          caption: message.message || null,
          date: message.date,
          ext: meta.ext,
          senderId: sender.id,
          senderName: sender.name,
        });

        const row = store.listMedia(chatId, 1, 0).find(m => m.message_id === message.id);
        if (row) {
          const dest = mediaPathForRow(row);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(uploadPath, dest);
          store.markFileByKey(chatId, message.id);

          try {
            if (await downloadThumbToDisk(client, message, chatId, message.id)) {
              store.markThumbByKey(chatId, message.id);
            }
          } catch { /* ignored */ }

          results.push(row);
        }
      }
    } catch (err) {
      console.error('Failed to upload file to Telegram:', err);
    } finally {
      try {
        fs.rmSync(tempSubdir, { recursive: true, force: true });
      } catch (err) {
        console.error('Failed to clean up upload temp subdirectory:', err);
      }
      if (fs.existsSync(file.path)) {
        fs.rmSync(file.path, { force: true });
      }
    }
  }
  res.json({ ok: true, added: results });
}));

app.post('/api/media/download-zip', asyncH(async (req, res) => {
  const { ids } = req.body || {};
  if (!ids || !Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'No media IDs provided' });
  }

  const rows = [];
  for (const id of ids) {
    const row = store.getMediaById(id);
    if (row) rows.push(row);
  }
  if (!rows.length) {
    return res.status(404).json({ error: 'No matching media files found' });
  }

  for (const row of rows) {
    const filePath = mediaPathForRow(row);
    if (!fs.existsSync(filePath)) {
      try {
        await ensureFullDownload(row);
      } catch (err) {
        console.error(`Failed to download media ${row.id} for zipping:`, err);
      }
    }
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="gallery-download.zip"');

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('ZIP archive error:', err);
    res.status(500).end();
  });
  archive.pipe(res);

  for (const row of rows) {
    const filePath = mediaPathForRow(row);
    if (fs.existsSync(filePath)) {
      const name = row.file_name || `${row.type || 'media'}-${row.message_id}.${row.ext || 'bin'}`;
      archive.file(filePath, { name });
    }
  }

  await archive.finalize();
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
