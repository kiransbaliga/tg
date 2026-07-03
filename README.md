# TG Gallery

A **local, offline, single-user** Google-Photos-style gallery for your Telegram
media. Runs entirely on your machine (`npm start`) and binds to `127.0.0.1`, so
nothing is exposed to the network. Point it at your Telegram
groups/channels/chats — each becomes an **album** — then browse, stream, and
download the photos and videos to this laptop.

It logs in as **your own Telegram account** (via MTProto / GramJS), which is the
only way to read a chat's *existing* history. (A bot can't — bots only see
messages sent after they join, and can't download files over 20 MB.)

> Your media is sent as **documents** ("send as file"), so the sync engine detects
> real photos/videos by MIME type — those show up in the gallery; other file types
> (pdf, zip…) are ignored.

## What works today

- 🔑 One-time phone-code login as your user account (session saved locally).
- 🗂️ Add any of your chats as an album (pick from a searchable list).
- 🔄 Sync a chat's full history — pulls metadata + Telegram's own thumbnails (fast, small).
- 🖼️ Justified, date-grouped grid (Google-Photos-like) with lazy-loaded thumbnails.
- 🔍 Lightbox with keyboard nav, video playback (with seeking), and **Download original**.
- 💾 Full-res files download to `data/media/` on demand and are cached locally.

## Setup

**1. Get Telegram API credentials** (free):

- Go to https://my.telegram.org → **API development tools**.
- Create an app; copy the **api_id** and **api_hash**.

**2. Configure:**

```bash
cp .env.example .env
# edit .env and paste your TG_API_ID and TG_API_HASH
# (optional) set TG_GROUP to open one chat by default, e.g.
#   TG_GROUP=@my_photos_group   or   TG_GROUP=-1001234567890
```

> **Tip — the preset group.** Set `TG_GROUP` in `.env` to your photos group and
> the gallery opens straight to it on startup (and syncs it the first time).
> You can still add other chats from the sidebar. To find a private group's id,
> just add it once from **+ Add** — or use its `@username` / invite link.

**3. Log in** (one time — you'll be asked for your phone number, the login code
Telegram sends you, and your 2FA password if you have one):

```bash
npm run login
```

The session is saved to `data/session.txt` (git-ignored), so you only do this once.

**4. Run the gallery:**

```bash
npm start
```

Open **http://localhost:4321**.

## Using it

1. Click **+ Add** in the sidebar and pick a chat → it's added as an album and starts syncing.
2. Watch the item count climb; when sync finishes the grid fills in.
3. Click any tile to open it full-screen. Use **← / →** to move, **Esc** to close.
4. **⬇ Download original** saves the full-quality file (also cached under `data/media/`).
5. Hit **↻ Sync** any time to pull new items — syncs are incremental (only new messages).

## How it stores things

```
data/
  tg-gallery.db     SQLite metadata (albums + media index)  [node:sqlite]
  session.txt       your saved login session  (keep private)
  thumbs/<chatId>/<messageId>.jpg    grid thumbnails
  media/<chatId>/<messageId>.<ext>   full-res files (downloaded on demand)
```

Everything under `data/` and your `.env` are git-ignored.

## Notes & limits

- **Opening a video** downloads the whole file first, then streams it (with seek
  support) — the first open of a large video can take a moment; after that it's cached.
- Requires **Node ≥ 22** (uses the built-in `node:sqlite`). Built and tested on Node 24.
- This is a local, single-user tool — the server has no auth and binds to localhost.

## Roadmap (next)

- Upload / sync **to** Telegram (Google-Photos-style backup) via bot or user account.
- Bulk select + zip download.
- Background/auto sync and a "download all" for an album.
- Search by caption / filename, and a combined "all albums" timeline view.

## Commands

| Command         | What it does                                  |
| --------------- | --------------------------------------------- |
| `npm run login` | Interactive phone-code login (one time)       |
| `npm start`     | Start the gallery server (http://localhost:4321) |
| `npm run dev`   | Same, with auto-restart on file changes       |
