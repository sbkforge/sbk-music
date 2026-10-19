# SBK Music

An open source music player for free, legal music. It runs on Cloudflare's free plan with no build step, no framework and no credit card.

Out of the box it streams from:

- **Internet Archive netlabels**: 60,000+ albums released under Creative Commons licenses
- **Internet Archive live music (etree)**: concert recordings that the artists allow to be shared
- **ccMixter**: Creative Commons singles and remixes
- **Popular**: official 30-second previews of almost any song (top charts plus search), from Apple's public iTunes API, each with a link to the full song
- **SoundCloud**: paste a song or playlist link and the full track plays in SoundCloud's own embedded player (links are saved in your browser)

You can also upload your own songs, which are stored in Workers KV.

## Features

- Browse and search free albums, live shows and singles, with cover art
- Album pages with license and source links for attribution
- Stream your own uploads from Workers KV (seeking works, via HTTP range requests)
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
| `GET /api/web/search?source=netlabels\|live&q=&page=` | Search Internet Archive albums |
| `GET /api/web/album/<id>` | Tracks of one album (only netlabel CC albums and etree shows) |
| `GET /api/web/tracks?q=&page=` | Search ccMixter singles |
| `GET /api/web/ccm/<path>` | Stream a ccMixter file (its server blocks direct links) |
| `GET /api/web/popular?q=&country=` | Top songs, or search any song (30-second previews) |
| `GET /api/web/soundcloud?url=` | Look up a SoundCloud link's title and artwork |
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

- Only sources that are free and legal to stream are included. Please keep it that way in pull requests.
- Anyone with the URL can listen. Only people with the token can upload or delete.
- Only upload music you have the right to share.

## License

MIT
