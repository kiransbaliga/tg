import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import bigInt from 'big-integer';
import heicConvert from 'heic-convert';
import express from 'express';
import { ZipArchive } from 'archiver';
import { PORT, HOST, GROUP, PUBLIC_DIR, hasCredentials, DATA_DIR, R2_PUBLIC_URL, API_ID, API_HASH } from './config.js';
import * as store from './db.js';
import {
  getClient, getMe, listDialogs, resolveEntity, buildInputPeer,
  ensureFullDownload, downloadThumbToR2, extractMedia, extractSender,
} from './telegram.js';
import { existsInR2, uploadToR2, getFromR2Stream, getPresignedUploadUrl, deleteFromR2, uploadStreamToR2 } from './r2.js';
import { syncAlbum, getSyncStatus } from './sync.js';
import { TelegramClient, Api, client as tgClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { CustomFile } from 'telegram/client/uploads.js';

const app = express();
app.use(express.json());

// Media responses redirect to the R2 custom domain, which has Cloudflare Hotlink
// Protection (blocks requests with a foreign Referer). Emitting no Referer keeps
// those requests allowed whether the app runs on localhost or a hosted domain.
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ---- global auth guard --------------------------------------------------
// Block all /api/ routes (except auth and status) when no session is present.
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/status') return next();

  const auth = req.headers.authorization;
  const hasHeader = auth && auth.startsWith('Bearer ') && auth.substring(7).trim().length > 0;
  const hasQuery = req.query.session && req.query.session.trim().length > 0;

  if (!hasHeader && !hasQuery) {
    return res.status(401).json({ error: 'Not logged in to Telegram. Access denied.' });
  }
  next();
});

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function clientError(err) {
  if (err?.message === 'NO_CREDENTIALS') {
    return { status: 428, error: 'Missing API credentials. Add TG_API_ID and TG_API_HASH to your .env file.' };
  }
  if (err?.message === 'NOT_AUTHORIZED') {
    return { status: 401, error: 'Not logged in to Telegram. Access denied.' };
  }
  if (err?.message === 'ACCESS_DENIED') {
    return { status: 403, error: 'You do not have access to this album.' };
  }
  return { status: 500, error: err?.message || 'Server error' };
}

// ---- stateless client caching & connection pool -------------------------

const clientCache = new Map(); // sessionString -> { client, lastUsed }
const activeLogins = new Map(); // loginId -> { client, phoneCodeHash, phoneNumber, createdAt }

async function getCachedClient(sessionString) {
  if (clientCache.has(sessionString)) {
    const entry = clientCache.get(sessionString);
    entry.lastUsed = Date.now();
    return entry.client;
  }
  const client = await getClient(sessionString);
  clientCache.set(sessionString, { client, lastUsed: Date.now() });
  return client;
}

// Clean up idle connections periodically
setInterval(() => {
  const now = Date.now();
  for (const [session, entry] of clientCache.entries()) {
    if (now - entry.lastUsed > 10 * 60 * 1000) { // 10 minutes idle
      entry.client.disconnect().catch(() => {});
      clientCache.delete(session);
    }
  }
  for (const [id, flow] of activeLogins.entries()) {
    if (now - flow.createdAt > 15 * 60 * 1000) { // 15 minutes login timeout
      flow.client.disconnect().catch(() => {});
      activeLogins.delete(id);
    }
  }
}, 60 * 1000);

// Helper to extract session from headers
function getSession(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.substring(7).trim();
  }
  if (req.query.session) {
    return req.query.session.trim();
  }
  return null;
}

async function getReqClient(req) {
  const session = getSession(req);
  if (!session) throw new Error('NOT_AUTHORIZED');
  return getCachedClient(session);
}

// ---- per-session chat access verification --------------------------------
const accessCache = new Map(); // key: "session:chatId" -> { allowed: bool, ts: number }
const ACCESS_TTL = 10 * 60 * 1000; // 10 minutes

async function verifyAccess(req, chatId) {
  const session = getSession(req);
  if (!session) throw new Error('NOT_AUTHORIZED');

  const cacheKey = `${session.substring(0, 16)}:${chatId}`;
  const cached = accessCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < ACCESS_TTL) {
    if (!cached.allowed) throw new Error('ACCESS_DENIED');
    return;
  }

  const client = await getCachedClient(session);
  const album = await store.getAlbum(chatId);
  if (!album) throw new Error('ALBUM_NOT_FOUND');

  try {
    const peer = buildInputPeer(album);
    await client.getMessages(peer, { limit: 1 });
    accessCache.set(cacheKey, { allowed: true, ts: Date.now() });
  } catch (err) {
    accessCache.set(cacheKey, { allowed: false, ts: Date.now() });
    throw new Error('ACCESS_DENIED');
  }
}

// ---- web authentication --------------------------------------------------

app.post('/api/auth/send-code', asyncH(async (req, res) => {
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5,
  });
  await client.connect();

  const { phoneCodeHash } = await client.sendCode({
    apiId: API_ID,
    apiHash: API_HASH,
  }, phoneNumber);

  const loginId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  activeLogins.set(loginId, { client, phoneCodeHash, phoneNumber, createdAt: Date.now() });

  res.json({ loginId });
}));

app.post('/api/auth/sign-in', asyncH(async (req, res) => {
  const { loginId, code, password } = req.body || {};
  if (!loginId || !code) return res.status(400).json({ error: 'loginId and code are required' });

  const flow = activeLogins.get(loginId);
  if (!flow) return res.status(400).json({ error: 'Login flow expired or invalid. Please request code again.' });

  try {
    let result;
    try {
      result = await flow.client.invoke(new Api.auth.SignIn({
        phoneNumber: flow.phoneNumber,
        phoneCodeHash: flow.phoneCodeHash,
        phoneCode: code,
      }));
    } catch (err) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        // 2FA is enabled — use the password
        if (!password) {
          return res.status(400).json({ error: 'This account has 2FA enabled. Please enter your password.' });
        }
        const { computeCheck } = await import('telegram/Password.js');
        const srpResult = await flow.client.invoke(new Api.account.GetPassword());
        const srpCheck = await computeCheck(srpResult, password);
        result = await flow.client.invoke(new Api.auth.CheckPassword({ password: srpCheck }));
      } else {
        throw err;
      }
    }

    const sessionString = flow.client.session.save();
    const me = await getMe(flow.client);

    // Cache the connected client for instant reuse
    clientCache.set(sessionString, { client: flow.client, lastUsed: Date.now() });
    activeLogins.delete(loginId);

    res.json({ ok: true, session: sessionString, me });
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Verification failed' });
  }
}));

// ---- status -------------------------------------------------------------

app.get('/api/status', asyncH(async (req, res) => {
  const creds = hasCredentials();
  const base = { hasCredentials: creds, presetGroup: GROUP || null };
  if (!creds) return res.json({ ...base, authenticated: false, me: null });

  const session = getSession(req);
  if (!session) return res.json({ ...base, authenticated: false, me: null });

  try {
    const client = await getCachedClient(session);
    const me = await getMe(client);
    res.json({ ...base, authenticated: true, me });
  } catch (err) {
    res.json({ ...base, authenticated: false, me: null, reason: err?.message || null });
  }
}));

// ---- dialogs ------------------------------------------------------------

app.get('/api/dialogs', asyncH(async (req, res) => {
  try {
    const client = await getReqClient(req);
    res.json(await listDialogs(client));
  } catch (err) {
    const e = clientError(err);
    res.status(e.status).json({ error: e.error });
  }
}));

// ---- albums -------------------------------------------------------------

app.get('/api/albums', asyncH(async (req, res) => {
  res.json(await store.listAlbums());
}));

app.post('/api/albums', asyncH(async (req, res) => {
  const { chatId, title, username, peerType, accessHash, kind } = req.body || {};
  if (!chatId) return res.status(400).json({ error: 'chatId is required' });
  const album = await store.upsertAlbum({ chatId, title, username, peerType, accessHash, kind });
  res.json(album);
}));

app.post('/api/albums/resolve', asyncH(async (req, res) => {
  const client = await getReqClient(req);
  const spec = ((req.body?.spec ?? '') || GROUP).toString().trim();
  if (!spec) return res.status(400).json({ error: 'No group specified' });
  try {
    const album = await store.upsertAlbum(await resolveEntity(client, spec));
    res.json(album);
  } catch (err) {
    if (/could not find|cannot find|no user|USERNAME_(NOT_OCCUPIED|INVALID)|Cannot cast/i.test(err?.message || '')) {
      return res.status(404).json({ error: `Could not find "${spec}".` });
    }
    const e = clientError(err);
    res.status(e.status).json({ error: e.error });
  }
}));

app.delete('/api/albums/:chatId', asyncH(async (req, res) => {
  await store.deleteAlbum(req.params.chatId);
  res.json({ ok: true });
}));

app.post('/api/albums/:chatId/sync', asyncH(async (req, res) => {
  try {
    await verifyAccess(req, req.params.chatId);
    const client = await getReqClient(req);
    if (req.query.full === '1') await store.resetAlbumSync(req.params.chatId);
    const status = syncAlbum(client, req.params.chatId);
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

app.get('/api/albums/:chatId/uploaders', asyncH(async (req, res) => {
  await verifyAccess(req, req.params.chatId);
  res.json(await store.listUploaders(req.params.chatId));
}));

app.get('/api/albums/:chatId/media', asyncH(async (req, res) => {
  const chatId = req.params.chatId;
  await verifyAccess(req, chatId);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 1000);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  const senderId = req.query.sender || null;
  const items = await store.listMedia(chatId, limit, offset, senderId);
  const total = await store.countMedia(chatId, senderId);
  res.json({ items, total, limit, offset });
}));

// ---- media bytes (R2 redirects with on-demand background cache) ----------

app.get('/api/media/:id/thumb', asyncH(async (req, res) => {
  const row = await store.getMediaById(req.params.id);
  if (!row) return res.status(404).end();
  await verifyAccess(req, row.chat_id);

  const r2Key = `thumbs/${row.chat_id}/${row.message_id}.jpg`;
  const publicUrl = `${R2_PUBLIC_URL}/${r2Key}`;

  if (row.thumb_downloaded === 1) {
    return res.redirect(publicUrl);
  }

  // Check R2 directly just in case metadata sync is out of sync
  if (await existsInR2(r2Key)) {
    await store.markThumbByKey(row.chat_id, row.message_id);
    return res.redirect(publicUrl);
  }

  // Lazy fallback: download to R2 on demand
  try {
    const client = await getReqClient(req);
    const peer = buildInputPeer(await store.getAlbum(row.chat_id));
    const messages = await client.getMessages(peer, { ids: [Number(row.message_id)] });
    const message = messages && messages[0];
    if (message && await downloadThumbToR2(client, message, row.chat_id, row.message_id)) {
      await store.markThumbByKey(row.chat_id, row.message_id);
      return res.redirect(publicUrl);
    } else {
      if (!message) {
        await store.deleteMediaRow(row.id);
      }
    }
  } catch (err) {
    console.error('Failed to download thumb on demand:', err);
    if (err?.message === 'MESSAGE_NOT_FOUND' || err?.message?.includes('message not found') || err?.message?.includes('CHAT_ADMIN_REQUIRED')) {
      await store.deleteMediaRow(row.id);
    }
  }
  res.status(404).end();
}));

app.get('/api/media/:id/file', asyncH(async (req, res) => {
  const row = await store.getMediaById(req.params.id);
  if (!row) return res.status(404).end();
  await verifyAccess(req, row.chat_id);

  const r2Key = `media/${row.chat_id}/${row.message_id}.${row.ext || 'bin'}`;
  const publicUrl = `${R2_PUBLIC_URL}/${r2Key}`;
  const isHeic = row.ext?.toLowerCase() === 'heic' || row.ext?.toLowerCase() === 'heif';
  const isDownload = req.query.download === '1';

  // Handle Safari/Chrome HEIC transcoding dynamically in memory
  if (isHeic && !isDownload) {
    const heicJpgKey = `media/${row.chat_id}/${row.message_id}.heic.jpg`;
    const heicJpgUrl = `${R2_PUBLIC_URL}/${heicJpgKey}`;

    if (await existsInR2(heicJpgKey)) {
      return res.redirect(heicJpgUrl);
    }

    try {
      const client = await getReqClient(req);
      const hasOriginal = await existsInR2(r2Key);
      if (!hasOriginal) {
        await ensureFullDownload(client, row);
      }

      // Convert
      const stream = await getFromR2Stream(r2Key);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      const outputBuffer = await heicConvert({
        buffer,
        format: 'JPEG',
        quality: 0.9,
      });

      await uploadToR2(heicJpgKey, outputBuffer, 'image/jpeg');
      return res.redirect(heicJpgUrl);
    } catch (err) {
      console.error(`HEIC conversion failed for row ${row.id}:`, err);
    }
  }

  // Inline views redirect to the CDN (keeps Range requests working for video
  // seeking). Downloads instead proxy the bytes through the server so the browser
  // force-saves with the correct filename — a cross-origin redirect makes the
  // <a download> attribute a no-op and can't set Content-Disposition.
  const deliver = async (key, contentType) => {
    if (!isDownload) return res.redirect(`${R2_PUBLIC_URL}/${key}`);
    const filename = (row.file_name || `media-${row.id}.${row.ext || 'bin'}`).replace(/["\\\r\n]/g, '');
    const stream = await getFromR2Stream(key);
    res.setHeader('Content-Type', contentType || row.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (row.file_size) {
      res.setHeader('Content-Length', row.file_size.toString());
    }
    stream.on('error', () => { if (res.headersSent) res.destroy(); else res.status(502).end(); });
    return stream.pipe(res);
  };

  if (row.file_downloaded === 1) {
    return deliver(r2Key);
  }

  if (await existsInR2(r2Key)) {
    await store.markFileByKey(row.chat_id, row.message_id);
    return deliver(r2Key);
  }

  // Lazy download from Telegram to R2 with instant streaming (handles ranges for videos/inline view, and progress headers for downloads)
  try {
    const client = await getReqClient(req);
    
    // Parse Range header if present
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = row.file_size ? Number(row.file_size) - 1 : null;
    let isRange = false;

    if (rangeHeader && row.file_size) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const partialStart = parts[0];
      const partialEnd = parts[1];
      start = Number.parseInt(partialStart, 10);
      end = partialEnd ? Number.parseInt(partialEnd, 10) : Number(row.file_size) - 1;
      isRange = true;
    }

    const chunkLimit = end !== null ? (end - start + 1) : undefined;

    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');

    if (isRange && row.file_size) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${row.file_size}`);
      res.setHeader('Content-Length', chunkLimit.toString());
    } else if (row.file_size) {
      res.setHeader('Content-Length', row.file_size.toString());
    }

    if (isDownload) {
      const filename = (row.file_name || `media-${row.id}.${row.ext || 'bin'}`).replace(/["\\\r\n]/g, '');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    const peer = buildInputPeer(await store.getAlbum(row.chat_id));
    const messages = await client.getMessages(peer, { ids: [Number(row.message_id)] });
    const message = messages && messages[0];
    if (!message || !message.media) {
      throw new Error('MESSAGE_NOT_FOUND');
    }

    // Stream background caching to R2 only if it's a full request.
    // If it's a range/partial request (e.g. video scrub/preview), trigger ensureFullDownload in the background.
    let passThrough = null;
    let uploadPromise = null;
    let completed = false;

    const triggerBackgroundCache = () => {
      ensureFullDownload(client, row).catch((err) => {
        console.error('Background cache download failed:', err);
      });
    };

    if (!isRange && row.file_size) {
      passThrough = new PassThrough();
      
      res.on('close', () => {
        if (!completed) {
          passThrough.destroy();
          deleteFromR2(r2Key).catch(() => {});
        }
      });

      uploadPromise = uploadStreamToR2(r2Key, passThrough, row.mime || 'application/octet-stream', row.file_size)
        .then(async () => {
          if (completed) {
            await store.markFileByKey(row.chat_id, row.message_id);
          }
        })
        .catch((err) => {
          console.error('Background R2 upload failed:', err);
        });
    } else {
      triggerBackgroundCache();
    }

    try {
      const downloadStream = tgClient.downloads.iterDownload(client, {
        file: message.media,
        offset: bigInt(start),
        limit: chunkLimit ? bigInt(chunkLimit) : undefined,
        requestSize: 512 * 1024, // 512KB chunks
      });

      for await (const chunk of downloadStream) {
        res.write(chunk);
        if (passThrough) {
          passThrough.write(chunk);
        }
      }
      res.end();
      if (passThrough) {
        passThrough.end();
      }
      completed = true;
      if (uploadPromise) {
        await uploadPromise;
      }
    } catch (err) {
      completed = false;
      if (passThrough) {
        passThrough.destroy();
        deleteFromR2(r2Key).catch(() => {});
      }
      throw err;
    }
  } catch (err) {
    if (err?.message === 'MESSAGE_NOT_FOUND' || err?.message?.includes('message not found') || err?.message?.includes('CHAT_ADMIN_REQUIRED')) {
      await store.deleteMediaRow(row.id).catch(() => {});
    }
    const e = clientError(err);
    if (!res.headersSent) {
      res.status(e.status).json({ error: e.error });
    } else {
      res.destroy();
    }
  }
}));

// ---- direct client-side upload helper endpoints --------------------------

app.get('/api/albums/:chatId/upload-urls', asyncH(async (req, res) => {
  const { files } = req.query; // JSON array of { name, mime }
  if (!files) return res.status(400).json({ error: 'files parameter is required' });
  
  try {
    const parsedFiles = JSON.parse(files);
    const urls = [];
    for (const f of parsedFiles) {
      const ext = f.name.split('.').pop() || 'bin';
      const tempId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      const r2Key = `temp/uploads/${tempId}.${ext}`;
      const uploadUrl = await getPresignedUploadUrl(r2Key, f.mime);
      urls.push({
        originalName: f.name,
        mime: f.mime,
        r2Key,
        uploadUrl,
      });
    }
    res.json({ urls });
  } catch (err) {
    res.status(400).json({ error: 'Invalid files query string: ' + err.message });
  }
}));

app.post('/api/albums/:chatId/upload-confirm', asyncH(async (req, res) => {
  const chatId = req.params.chatId;
  const album = await store.getAlbum(chatId);
  if (!album) return res.status(404).json({ error: 'Album not found' });
  const { uploads } = req.body || {}; // array of { r2Key, mime, originalName }
  if (!uploads || !uploads.length) return res.status(400).json({ error: 'No uploads provided' });

  const client = await getReqClient(req);
  const peer = buildInputPeer(album);
  const results = [];

  for (const u of uploads) {
    try {
      // Stream temp file from R2
      const stream = await getFromR2Stream(u.r2Key);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      // Send to Telegram with an explicit filename + mime. Passing a raw Buffer
      // makes GramJS name the document "unnamed" with no extension, so Telegram
      // can't recognize the type and the file won't preview / open. Wrap it in a
      // CustomFile and set the filename attribute so it arrives as a proper file.
      // (The filename must NOT go in the caption — that's message text, not a name.)
      const upload = new CustomFile(u.originalName, buffer.length, '', buffer);
      const message = await client.sendFile(peer, {
        file: upload,
        forceDocument: true,
        mimeType: u.mime || undefined,
        attributes: [new Api.DocumentAttributeFilename({ fileName: u.originalName })],
      });

      const meta = extractMedia(message);
      if (meta) {
        const sender = extractSender(message);
        await store.insertMedia({
          chatId,
          messageId: message.id,
          groupedId: message.groupedId ? message.groupedId.toString() : null,
          type: meta.type,
          mime: meta.mime || u.mime,
          fileName: meta.fileName || u.originalName,
          fileSize: meta.fileSize || buffer.length,
          width: meta.width,
          height: meta.height,
          duration: meta.duration,
          caption: message.message || null,
          date: message.date,
          ext: meta.ext,
          senderId: sender.id,
          senderName: sender.name,
        });

        // Copy from temp Key to final media key in R2
        const finalKey = `media/${chatId}/${message.id}.${meta.ext}`;
        await uploadToR2(finalKey, buffer, meta.mime || u.mime);
        await store.markFileByKey(chatId, message.id);

        try {
          if (await downloadThumbToR2(client, message, chatId, message.id)) {
            await store.markThumbByKey(chatId, message.id);
          }
        } catch { /* ignored */ }

        const row = (await store.listMedia(chatId, 1, 0)).find(m => m.message_id === message.id);
        if (row) results.push(row);
      }
    } catch (err) {
      console.error('Failed to process uploaded file confirmation:', err);
    } finally {
      // Clean up temp R2 upload file
      deleteFromR2(u.r2Key).catch(() => {});
    }
  }

  res.json({ ok: true, added: results });
}));

// ---- ZIP downloads -------------------------------------------------------

app.post('/api/media/download-zip', asyncH(async (req, res) => {
  const { ids } = req.body || {};
  if (!ids || !Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'No media IDs provided' });
  }
  const client = await getReqClient(req);

  const rows = [];
  for (const id of ids) {
    const row = await store.getMediaById(id);
    if (row) rows.push(row);
  }
  if (!rows.length) return res.status(404).json({ error: 'No matching media files found' });

  // Pre-download all uncached files into R2
  for (const row of rows) {
    const r2Key = `media/${row.chat_id}/${row.message_id}.${row.ext || 'bin'}`;
    if (!(await existsInR2(r2Key))) {
      try {
        await ensureFullDownload(client, row);
      } catch (err) {
        console.error(`Failed to download media ${row.id} for zipping:`, err);
        if (err?.message === 'MESSAGE_NOT_FOUND' || err?.message?.includes('message not found') || err?.message?.includes('CHAT_ADMIN_REQUIRED')) {
          await store.deleteMediaRow(row.id).catch(() => {});
        }
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
    const r2Key = `media/${row.chat_id}/${row.message_id}.${row.ext || 'bin'}`;
    if (await existsInR2(r2Key)) {
      const stream = await getFromR2Stream(r2Key);
      const name = row.file_name || `${row.type || 'media'}-${row.message_id}.${row.ext || 'bin'}`;
      archive.append(stream, { name });
    }
  }

  await archive.finalize();
}));

// ---- static frontend ----------------------------------------------------

app.use(express.static(PUBLIC_DIR));

// Error handler
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const e = clientError(err);
  res.status(e.status).json({ error: e.error });
});

// Bind explicitly to HOST (0.0.0.0 by default) so hosting platforms like Render
// can detect the open port — they probe 0.0.0.0:$PORT, not 127.0.0.1.
app.listen(PORT, HOST, () => {
  console.log(`\n  TG Gallery running on  ${HOST}:${PORT}\n`);
});
