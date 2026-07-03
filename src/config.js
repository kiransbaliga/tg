import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DB_PATH = path.join(DATA_DIR, 'tg-gallery.db');
export const SESSION_PATH = path.join(DATA_DIR, 'session.txt');

export const API_ID = Number.parseInt(process.env.TG_API_ID || '', 10);
export const API_HASH = (process.env.TG_API_HASH || '').trim();
// Optional: a chat to open by default on startup. Accepts an @username,
// a https://t.me/... link, or a numeric chat id. If unset, you pick from the
// sidebar. Great for "always open my photos group".
export const GROUP = (process.env.TG_GROUP || '').trim();
export const PORT = Number.parseInt(process.env.PORT || '4321', 10);
// Bind to loopback by default (safe for local use). Set HOST=0.0.0.0 only when
// the app is deployed behind auth / a reverse proxy.
export const HOST = (process.env.HOST || '127.0.0.1').trim();

// Ensure the on-disk layout exists before anything touches it.
for (const dir of [DATA_DIR, MEDIA_DIR, THUMBS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export function hasCredentials() {
  return Number.isFinite(API_ID) && API_ID > 0 && API_HASH.length > 0;
}

export function loadSession() {
  try {
    return fs.readFileSync(SESSION_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

export function saveSession(sessionString) {
  fs.writeFileSync(SESSION_PATH, sessionString, { mode: 0o600 });
}
