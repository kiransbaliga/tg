import { buildInputPeer, extractMedia, downloadThumbToR2, extractSender } from './telegram.js';
import { existsInR2 } from './r2.js';
import * as store from './db.js';

const GALLERY_TYPES = new Set(['photo', 'image', 'video', 'gif', 'document']);

// chatId -> live status object (mutated in place as sync runs)
const statusByChat = new Map();

export function getSyncStatus(chatId) {
  return statusByChat.get(String(chatId)) || null;
}

export function syncAlbum(client, chatId) {
  chatId = String(chatId);
  const existing = statusByChat.get(chatId);
  if (existing?.running) return existing;

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
      const album = await store.getAlbum(chatId);
      if (!album) throw new Error('ALBUM_NOT_FOUND');

      const peer = buildInputPeer(album);
      const minId = album.last_synced_msg_id || 0;
      let maxId = minId;

      for await (const message of client.iterMessages(peer, { minId, waitTime: 0.5 })) {
        status.processed++;
        if (message.id > maxId) maxId = message.id;

        const meta = extractMedia(message);
        if (!meta || !GALLERY_TYPES.has(meta.type)) continue;

        const sender = extractSender(message);
        const isNew = await store.insertMedia({
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
          const r2Key = `thumbs/${chatId}/${message.id}.jpg`;
          const exists = await existsInR2(r2Key);
          if (!exists) {
            try {
              if (await downloadThumbToR2(client, message, chatId, message.id)) {
                await store.markThumbByKey(chatId, message.id);
                status.thumbs++;
              }
            } catch { /* failed thumb is non-fatal */ }
          }
        }
      }

      await store.setAlbumSynced(chatId, maxId);
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
