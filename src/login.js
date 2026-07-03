import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { API_ID, API_HASH, hasCredentials, loadSession, saveSession } from './config.js';

if (!hasCredentials()) {
  console.error(
    '\nMissing Telegram API credentials.\n' +
    '  1. Go to https://my.telegram.org  ->  API development tools\n' +
    '  2. Create an app and copy the api_id and api_hash\n' +
    "  3. Copy .env.example to .env and fill in TG_API_ID / TG_API_HASH\n",
  );
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

const session = new StringSession(loadSession());
const client = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5 });
try { client.setLogLevel?.('error'); } catch { /* noop */ }
try { client.logger?.setLevel?.('error'); } catch { /* noop */ }

console.log('\nLogging in to Telegram as your user account...\n');

try {
  await client.start({
    phoneNumber: async () => (await ask('Phone number (with country code, e.g. +15551234567): ')).trim(),
    password: async () => ask('2FA password (leave blank if you have none): '),
    phoneCode: async () => (await ask('Login code (sent to your Telegram app): ')).trim(),
    onError: (err) => console.error('Login error:', err?.message || err),
  });

  saveSession(client.session.save());
  const me = await client.getMe();
  const name = [me.firstName, me.lastName].filter(Boolean).join(' ');
  console.log(`\n✓ Logged in as ${name || me.username || me.id}. Session saved to data/session.txt`);
  console.log('  You can now run:  npm start\n');
} catch (err) {
  console.error('\n✗ Login failed:', err?.message || err);
  process.exitCode = 1;
} finally {
  rl.close();
  await client.disconnect().catch(() => {});
  process.exit(process.exitCode || 0);
}
