import { getClient, buildInputPeer, extractMedia, downloadThumbToDisk, extractSender } from './telegram.js';
import * as store from './db.js';

const GALLERY_TYPES = new Set(['photo', 'image', 'video', 'gif']);

// chatId -> live status object (mutated in place as sync runs)
const statusByChat = new Map();

export function getSyncStatus(chatId) {
  return statusByChat.get(String(chatId)) || null;
}

/**
 * Sync a chat's media into the DB. Incremental: only messages newer than the
 * album's last_synced_msg_id are scanned. Runs in the background; progress is
 * exposed via getSyncStatus(). Returns the status object immediately.
 */
export function syncAlbum(chatId) {
  chatId = String(chatId);
  const existing = statusByChat.get(chatId);
  if (existing?.running) return existing;

  const album = store.getAlbum(chatId);
  if (!album) throw new Error('ALBUM_NOT_FOUND');

  const status = {
    chatId,
    running: true,
    done: false,
    error: null,
    processed: 0,
    added: 0,
    thumbs: 0,
    startedAt: Date.now(),
    finishedAt: null,
  };
  statusByChat.set(chatId, status);

  (async () => {
    try {
      const client = await getClient();
      const peer = buildInputPeer(album);
      const minId = album.last_synced_msg_id || 0;
      let maxId = minId;

      for await (const message of client.iterMessages(peer, { minId, waitTime: 0.5 })) {
        status.processed++;
        if (message.id > maxId) maxId = message.id;

        const meta = extractMedia(message);
        if (!meta || !GALLERY_TYPES.has(meta.type)) continue;

        const sender = extractSender(message);
        const isNew = store.insertMedia({
          chatId,
          messageId: message.id,
          groupedId: message.groupedId ? message.groupedId.toString() : null,
          type: meta.type,
          mime: meta.mime,
          fileName: meta.fileName,
          fileSize: meta.fileSize,
          width: meta.width,
          height: meta.height,
          duration: meta.duration,
          caption: message.message || null,
          date: message.date,
          ext: meta.ext,
          senderId: sender.id,
          senderName: sender.name,
        });

        if (isNew) {
          status.added++;
          try {
            if (await downloadThumbToDisk(client, message, chatId, message.id)) {
              store.markThumbByKey(chatId, message.id);
              status.thumbs++;
            }
          } catch { /* a failed thumb is non-fatal; grid falls back gracefully */ }
        }
      }

      store.setAlbumSynced(chatId, maxId);
    } catch (err) {
      status.error = err?.message || String(err);
    } finally {
      status.running = false;
      status.done = true;
      status.finishedAt = Date.now();
    }
  })();

  return status;
}
