# SBK Music

An open source music player that runs on Cloudflare's free plan. Songs live in Workers KV, a Worker streams them, and the player is a plain HTML/JS page. No build step, no framework, no credit card.

## Features

- Stream your own songs from Workers KV (seeking works, via HTTP range requests)
- Search across title, artist and album
- Shuffle, repeat, next/previous, volume, seek bar
- Keyboard: Space play/pause, ← → prev/next, S shuffle, R repeat, / search
- Lock screen and headphone controls (Media Session API)
- Upload and delete songs from the browser, protected by a secret token
- Light and dark mode, works on phones

## How it works

```
browser ──> Worker (src/worker.js) ──> KV namespace "MUSIC"
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

You need a free Cloudflare account and Node.js.

```sh
npm install
npx wrangler login
npx wrangler kv namespace create MUSIC   # put the printed id in wrangler.jsonc
npx wrangler secret put UPLOAD_TOKEN     # any long random value
npm run deploy
```

Open the `*.workers.dev` URL it prints, click **Upload**, paste the token, and drop in some songs.

### Auto-deploy on push

`.github/workflows/deploy.yml` deploys on every push to `main`. Add two repo secrets (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN`: create one at dash.cloudflare.com/profile/api-tokens with the **Edit Cloudflare Workers** template
- `CLOUDFLARE_ACCOUNT_ID`: shown by `npx wrangler whoami`

Without them, the workflow skips the deploy step.

### Local development

```sh
cp .dev.vars.example .dev.vars   # set UPLOAD_TOKEN
npm run dev                      # uses a local KV store
```

## Free plan limits

- 25 MB per song (KV value limit)
- 1 GB of songs in total
- 1,000 uploads or deletes per day, 100,000 plays/list loads per day

## Notes

- Anyone with the URL can listen. Only people with the token can upload or delete.
- Only upload music you have the right to share.

## License

MIT
