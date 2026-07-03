import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.js';

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS albums (
    chat_id            TEXT PRIMARY KEY,
    title              TEXT,
    username           TEXT,
    peer_type          TEXT NOT NULL DEFAULT 'channel',  -- channel | chat | user
    access_hash        TEXT,
    kind               TEXT,                              -- group | supergroup | channel | user | bot
    last_synced_msg_id INTEGER NOT NULL DEFAULT 0,
    synced_at          INTEGER,
    created_at         INTEGER
  );

  CREATE TABLE IF NOT EXISTS media (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id          TEXT NOT NULL,
    message_id       INTEGER NOT NULL,
    grouped_id       TEXT,
    type             TEXT,      -- photo | image | video | gif
    mime             TEXT,
    file_name        TEXT,
    file_size        INTEGER,
    width            INTEGER,
    height           INTEGER,
    duration         REAL,
    caption          TEXT,
    date             INTEGER,   -- unix seconds (message date)
    ext              TEXT,
    thumb_downloaded INTEGER NOT NULL DEFAULT 0,
    file_downloaded  INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER,
    UNIQUE(chat_id, message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_media_chat_date ON media(chat_id, date DESC, message_id DESC);
`);

const nowSec = () => Math.floor(Date.now() / 1000);
const nn = (v) => (v === undefined ? null : v);

// ---- albums -------------------------------------------------------------

export function upsertAlbum({ chatId, title, username, peerType, accessHash, kind }) {
  db.prepare(`
    INSERT INTO albums (chat_id, title, username, peer_type, access_hash, kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      title       = excluded.title,
      username    = excluded.username,
      peer_type   = excluded.peer_type,
      access_hash = COALESCE(excluded.access_hash, albums.access_hash),
      kind        = excluded.kind
  `).run(
    String(chatId),
    nn(title),
    nn(username),
    peerType || 'channel',
    nn(accessHash),
    nn(kind),
    nowSec(),
  );
  return getAlbum(chatId);
}

export function getAlbum(chatId) {
  return db.prepare('SELECT * FROM albums WHERE chat_id = ?').get(String(chatId));
}

export function listAlbums() {
  return db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM media m WHERE m.chat_id = a.chat_id) AS media_count,
      (SELECT COUNT(*) FROM media m WHERE m.chat_id = a.chat_id AND m.file_downloaded = 1) AS downloaded_count
    FROM albums a
    ORDER BY a.created_at DESC
  `).all();
}

export function deleteAlbum(chatId) {
  db.prepare('DELETE FROM media WHERE chat_id = ?').run(String(chatId));
  db.prepare('DELETE FROM albums WHERE chat_id = ?').run(String(chatId));
}

export function setAlbumSynced(chatId, lastMsgId) {
  db.prepare(`
    UPDATE albums
    SET last_synced_msg_id = MAX(last_synced_msg_id, ?), synced_at = ?
    WHERE chat_id = ?
  `).run(Number(lastMsgId) || 0, nowSec(), String(chatId));
}

// ---- media --------------------------------------------------------------

export function insertMedia(row) {
  const info = db.prepare(`
    INSERT OR IGNORE INTO media
      (chat_id, message_id, grouped_id, type, mime, file_name, file_size,
       width, height, duration, caption, date, ext, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(row.chatId),
    Number(row.messageId),
    nn(row.groupedId),
    nn(row.type),
    nn(row.mime),
    nn(row.fileName),
    nn(row.fileSize),
    nn(row.width),
    nn(row.height),
    nn(row.duration),
    nn(row.caption),
    nn(row.date),
    nn(row.ext),
    nowSec(),
  );
  return info.changes > 0;
}

export function getMediaById(id) {
  return db.prepare('SELECT * FROM media WHERE id = ?').get(Number(id));
}

export function listMedia(chatId, limit, offset) {
  return db.prepare(`
    SELECT id, chat_id, message_id, type, mime, file_name, file_size,
           width, height, duration, caption, date, ext,
           thumb_downloaded, file_downloaded
    FROM media
    WHERE chat_id = ?
    ORDER BY date DESC, message_id DESC
    LIMIT ? OFFSET ?
  `).all(String(chatId), Number(limit), Number(offset));
}

export function countMedia(chatId) {
  return db.prepare('SELECT COUNT(*) AS c FROM media WHERE chat_id = ?').get(String(chatId)).c;
}

export function markThumbByKey(chatId, messageId) {
  db.prepare('UPDATE media SET thumb_downloaded = 1 WHERE chat_id = ? AND message_id = ?')
    .run(String(chatId), Number(messageId));
}

export function markFileByKey(chatId, messageId) {
  db.prepare('UPDATE media SET file_downloaded = 1 WHERE chat_id = ? AND message_id = ?')
    .run(String(chatId), Number(messageId));
}
