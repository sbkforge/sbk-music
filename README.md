# SBK Music

An open source music player that runs on Cloudflare. Songs live in an R2 bucket, a Worker streams them, and the player is a plain HTML/JS page. No build step, no framework.

## Features

- Stream your own songs from Cloudflare R2 (seeking works, via HTTP range requests)
- Search across title, artist and album
- Shuffle, repeat, next/previous, volume, seek bar
- Keyboard: Space play/pause, ← → prev/next, S shuffle, R repeat, / search
- Lock screen and headphone controls (Media Session API)
- Upload and delete songs from the browser, protected by a secret token
- Light and dark mode, works on phones

## How it works

```
browser ──> Worker (src/worker.js) ──> R2 bucket "sbk-music"
              │
              └─> static files (public/)
```

| Route | What it does |
|---|---|
| `GET /api/tracks` | List songs |
| `GET /api/stream/<key>` | Stream a song (supports Range) |
| `PUT /api/tracks/<key>` | Upload a song (needs token) |
| `DELETE /api/tracks/<key>` | Delete a song (needs token) |

Title and artist come from upload metadata, or from file names like `Artist - Title.mp3`.

## Deploy your own

You need a Cloudflare account (the free plan works).

1. **Create the bucket.** Cloudflare dashboard → R2 → Create bucket → name it `sbk-music`.
2. **Connect the repo.** Workers & Pages → Create → Import a repository → pick your fork of this repo. Leave the build command empty; the deploy command is `npx wrangler deploy`.
3. **Set the upload token.** In the Worker → Settings → Variables and secrets, add a secret `UPLOAD_TOKEN` with a long random value.
4. Open your `*.workers.dev` URL, click **Upload**, paste the token, drop in some songs.

Every push to `main` deploys again.

### Or from your computer

```sh
npm install
npx wrangler login
npx wrangler r2 bucket create sbk-music
npx wrangler secret put UPLOAD_TOKEN
npm run deploy
```

### Local development

```sh
cp .dev.vars.example .dev.vars   # set UPLOAD_TOKEN
npm run dev                      # uses a local R2 bucket
```

## Notes

- Anyone with the URL can listen. Only people with the token can upload or delete.
- Uploads go through the Worker, so each file is limited to 100 MB on the free plan.
- Only upload music you have the right to share.

## License

MIT
