import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');

// Ensure local data dir exists for temp uploads or local cache if needed
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const API_ID = Number.parseInt(process.env.TG_API_ID || '', 10);
export const API_HASH = (process.env.TG_API_HASH || '').trim();
export const GROUP = (process.env.TG_GROUP || '').trim();
export const PORT = Number.parseInt(process.env.PORT || '4321', 10);
export const HOST = (process.env.HOST || '0.0.0.0').trim(); // Default to 0.0.0.0 for hosting/Render compatibility

// Supabase (PostgreSQL) Config
export const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

// Cloudflare R2 Config
export const R2_ACCOUNT_ID = (process.env.R2_ACCOUNT_ID || '').trim();
export const R2_ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID || '').trim();
export const R2_SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
export const R2_BUCKET_NAME = (process.env.R2_BUCKET_NAME || '').trim();
// Normalize: the redirect targets need an absolute URL. If the env value omits
// the scheme (e.g. "ente-bucket.baliga.dev"), res.redirect() would treat it as a
// relative path and browsers would resolve it against localhost -> broken images.
const rawR2PublicUrl = (process.env.R2_PUBLIC_URL || '').trim().replace(/\/$/, '');
export const R2_PUBLIC_URL = rawR2PublicUrl && !/^https?:\/\//i.test(rawR2PublicUrl)
  ? `https://${rawR2PublicUrl}`
  : rawR2PublicUrl;

export function hasCredentials() {
  return Number.isFinite(API_ID) && API_ID > 0 && API_HASH.length > 0;
}
