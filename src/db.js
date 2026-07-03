import postgres from 'postgres';
import { DATABASE_URL } from './config.js';

const sql = DATABASE_URL
  ? postgres(DATABASE_URL, {
      ssl: { rejectUnauthorized: false }, // required for Supabase/Neon
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    })
  : null;

// Run migrations on startup if database is configured
async function runMigrations() {
  if (!sql) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS albums (
        chat_id            TEXT PRIMARY KEY,
        title              TEXT,
        username           TEXT,
        peer_type          TEXT NOT NULL DEFAULT 'channel',
        access_hash        TEXT,
        kind               TEXT,
        last_synced_msg_id INTEGER NOT NULL DEFAULT 0,
        synced_at          INTEGER,
        created_at         INTEGER
      );
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS media (
        id               SERIAL PRIMARY KEY,
        chat_id          TEXT NOT NULL REFERENCES albums(chat_id) ON DELETE CASCADE,
        message_id       INTEGER NOT NULL,
        grouped_id       TEXT,
        type             TEXT,
        mime             TEXT,
        file_name        TEXT,
        file_size        BIGINT,
        width            INTEGER,
        height           INTEGER,
        duration         REAL,
        caption          TEXT,
        date             INTEGER,
        ext              TEXT,
        sender_id        TEXT,
        sender_name      TEXT,
        thumb_downloaded INTEGER NOT NULL DEFAULT 0,
        file_downloaded  INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER,
        UNIQUE(chat_id, message_id)
      );
    `;

    await sql`CREATE INDEX IF NOT EXISTS idx_media_chat_date ON media(chat_id, date DESC, message_id DESC);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_media_sender ON media(chat_id, sender_id);`;

    console.log('✓ Supabase PostgreSQL migrations completed successfully.');
  } catch (err) {
    console.error('✗ Failed to run Supabase PostgreSQL migrations:', err);
  }
}

if (DATABASE_URL) {
  await runMigrations();
} else {
  console.warn('  ⚠ DATABASE_URL is not set. Supabase operations will fail until configured.');
}

const nowSec = () => Math.floor(Date.now() / 1000);
const nn = (v) => (v === undefined ? null : v);

function ensureDb() {
  if (!sql) throw new Error('DATABASE_NOT_CONFIGURED');
}

// ---- albums -------------------------------------------------------------

export async function upsertAlbum({ chatId, title, username, peerType, accessHash, kind }) {
  ensureDb();
  await sql`
    INSERT INTO albums (chat_id, title, username, peer_type, access_hash, kind, created_at)
    VALUES (
      ${String(chatId)}, 
      ${nn(title)}, 
      ${nn(username)}, 
      ${peerType || 'channel'}, 
      ${nn(accessHash)}, 
      ${nn(kind)}, 
      ${nowSec()}
    )
    ON CONFLICT(chat_id) DO UPDATE SET
      title       = EXCLUDED.title,
      username    = EXCLUDED.username,
      peer_type   = EXCLUDED.peer_type,
      access_hash = COALESCE(EXCLUDED.access_hash, albums.access_hash),
      kind        = EXCLUDED.kind
  `;
  return getAlbum(chatId);
}

export async function getAlbum(chatId) {
  ensureDb();
  const rows = await sql`SELECT * FROM albums WHERE chat_id = ${String(chatId)}`;
  return rows[0] || null;
}

export async function listAlbums() {
  ensureDb();
  return sql`
    SELECT a.*,
      COALESCE((SELECT COUNT(*) FROM media m WHERE m.chat_id = a.chat_id), 0)::int AS media_count,
      COALESCE((SELECT COUNT(*) FROM media m WHERE m.chat_id = a.chat_id AND m.file_downloaded = 1), 0)::int AS downloaded_count
    FROM albums a
    ORDER BY a.created_at DESC
  `;
}

export async function deleteAlbum(chatId) {
  ensureDb();
  await sql`DELETE FROM media WHERE chat_id = ${String(chatId)}`;
  await sql`DELETE FROM albums WHERE chat_id = ${String(chatId)}`;
}

export async function setAlbumSynced(chatId, lastMsgId) {
  ensureDb();
  await sql`
    UPDATE albums
    SET last_synced_msg_id = GREATEST(last_synced_msg_id, ${Number(lastMsgId) || 0}), synced_at = ${nowSec()}
    WHERE chat_id = ${String(chatId)}
  `;
}

export async function resetAlbumSync(chatId) {
  ensureDb();
  await sql`UPDATE albums SET last_synced_msg_id = 0 WHERE chat_id = ${String(chatId)}`;
}

// ---- media --------------------------------------------------------------

export async function insertMedia(row) {
  ensureDb();
  const result = await sql`
    INSERT INTO media
      (chat_id, message_id, grouped_id, type, mime, file_name, file_size,
       width, height, duration, caption, date, ext, sender_id, sender_name, created_at)
    VALUES (
      ${String(row.chatId)},
      ${Number(row.messageId)},
      ${nn(row.groupedId)},
      ${nn(row.type)},
      ${nn(row.mime)},
      ${nn(row.fileName)},
      ${nn(row.fileSize)},
      ${nn(row.width)},
      ${nn(row.height)},
      ${nn(row.duration)},
      ${nn(row.caption)},
      ${nn(row.date)},
      ${nn(row.ext)},
      ${nn(row.senderId)},
      ${nn(row.senderName)},
      ${nowSec()}
    )
    ON CONFLICT(chat_id, message_id) DO UPDATE SET
      sender_id   = COALESCE(EXCLUDED.sender_id,   media.sender_id),
      sender_name = COALESCE(EXCLUDED.sender_name, media.sender_name)
  `;
  return result.count > 0;
}

export async function getMediaById(id) {
  ensureDb();
  const rows = await sql`SELECT * FROM media WHERE id = ${Number(id)}`;
  return rows[0] || null;
}

export async function listMedia(chatId, limit, offset, senderId) {
  ensureDb();
  if (senderId) {
    return sql`
      SELECT id, chat_id, message_id, type, mime, file_name, file_size,
             width, height, duration, caption, date, ext,
             sender_id, sender_name,
             thumb_downloaded, file_downloaded
      FROM media
      WHERE chat_id = ${String(chatId)} AND sender_id = ${String(senderId)}
      ORDER BY date DESC, message_id DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    `;
  }
  return sql`
    SELECT id, chat_id, message_id, type, mime, file_name, file_size,
           width, height, duration, caption, date, ext,
           sender_id, sender_name,
           thumb_downloaded, file_downloaded
    FROM media
    WHERE chat_id = ${String(chatId)}
    ORDER BY date DESC, message_id DESC
    LIMIT ${Number(limit)} OFFSET ${Number(offset)}
  `;
}

export async function countMedia(chatId, senderId) {
  ensureDb();
  if (senderId) {
    const rows = await sql`SELECT COUNT(*)::int AS c FROM media WHERE chat_id = ${String(chatId)} AND sender_id = ${String(senderId)}`;
    return rows[0]?.c || 0;
  }
  const rows = await sql`SELECT COUNT(*)::int AS c FROM media WHERE chat_id = ${String(chatId)}`;
  return rows[0]?.c || 0;
}

export async function listUploaders(chatId) {
  ensureDb();
  return sql`
    SELECT sender_id, sender_name, COUNT(*)::int AS media_count
    FROM media
    WHERE chat_id = ${String(chatId)} AND sender_id IS NOT NULL
    GROUP BY sender_id
    ORDER BY media_count DESC
  `;
}

export async function markThumbByKey(chatId, messageId) {
  ensureDb();
  await sql`UPDATE media SET thumb_downloaded = 1 WHERE chat_id = ${String(chatId)} AND message_id = ${Number(messageId)}`;
}

export async function markFileByKey(chatId, messageId) {
  ensureDb();
  await sql`UPDATE media SET file_downloaded = 1 WHERE chat_id = ${String(chatId)} AND message_id = ${Number(messageId)}`;
}
