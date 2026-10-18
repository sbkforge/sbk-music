// sbk-music Worker: lists tracks, streams audio from Workers KV, and handles
// token-protected uploads and deletes. Static files come from ./public.
//
// Each song is one KV entry under "track:<file name>". Its metadata holds
// title, artist, album, size, content type and upload time, so listing
// never has to read the audio itself.

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm)$/i;
const PREFIX = "track:";
const MAX_BYTES = 25 * 1024 * 1024; // KV value limit

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname);

      if (path === "/api/tracks" && request.method === "GET") {
        return listTracks(env);
      }
      if (path.startsWith("/api/stream/")) {
        const key = path.slice("/api/stream/".length);
        if (request.method === "GET" || request.method === "HEAD") {
          return streamTrack(request, env, key);
        }
      }
      if (path.startsWith("/api/tracks/")) {
        const key = path.slice("/api/tracks/".length);
        if (request.method === "PUT") return uploadTrack(request, env, key);
        if (request.method === "DELETE") return deleteTrack(request, env, key);
      }
      if (path.startsWith("/api/")) {
        return json({ error: "Not found" }, 404);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: err.message || "Server error" }, 500);
    }
  },
};

async function listTracks(env) {
  const tracks = [];
  let cursor;
  do {
    const page = await env.MUSIC.list({ prefix: PREFIX, cursor });
    for (const k of page.keys) {
      const key = k.name.slice(PREFIX.length);
      const meta = k.metadata || {};
      const guess = guessFromName(key);
      tracks.push({
        key,
        title: meta.title || guess.title,
        artist: meta.artist || guess.artist,
        album: meta.album || "",
        size: meta.size || 0,
        uploaded: meta.uploaded || null,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  tracks.sort((a, b) =>
    (a.artist + a.title).localeCompare(b.artist + b.title)
  );
  return json({ tracks }, 200, { "cache-control": "no-store" });
}

async function streamTrack(request, env, key) {
  const { value, metadata } = await env.MUSIC.getWithMetadata(PREFIX + key, {
    type: "arrayBuffer",
    cacheTtl: 3600,
  });
  if (value === null) return json({ error: "Not found" }, 404);

  const size = value.byteLength;
  const etag = `"${(metadata && metadata.uploaded) || size}"`;
  const headers = new Headers({
    "content-type": (metadata && metadata.type) || "audio/mpeg",
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=86400",
    etag,
  });

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  // Browsers seek with Range requests; serve just the asked-for bytes.
  const range = parseRange(request.headers.get("range"), size);
  if (range === "invalid") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  let body = value;
  let status = 200;
  if (range) {
    body = value.slice(range.start, range.end + 1);
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    status = 206;
  }
  headers.set("content-length", String(body.byteLength));
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}

// Parses "bytes=a-b", "bytes=a-" and "bytes=-n". Returns null for no range.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start, end;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

async function uploadTrack(request, env, key) {
  if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
  if (!key || !AUDIO_EXT.test(key) || key.includes("..")) {
    return json({ error: "Use an audio file name like song.mp3" }, 400);
  }

  const data = await request.arrayBuffer();
  if (data.byteLength === 0) return json({ error: "Empty file" }, 400);
  if (data.byteLength > MAX_BYTES) {
    return json({ error: "File is over 25 MB" }, 413);
  }

  const h = request.headers;
  const metadata = {
    size: data.byteLength,
    type: h.get("content-type") || "audio/mpeg",
    uploaded: new Date().toISOString(),
  };
  // KV metadata is capped at 1 KB, so keep these short.
  for (const field of ["title", "artist", "album"]) {
    const value = h.get(`x-${field}`);
    if (value) metadata[field] = decodeURIComponent(value).slice(0, 150);
  }

  await env.MUSIC.put(PREFIX + key, data, { metadata });
  return json({ ok: true, key }, 201);
}

async function deleteTrack(request, env, key) {
  if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
  await env.MUSIC.delete(PREFIX + key);
  return json({ ok: true });
}

function authorized(request, env) {
  const expected = env.UPLOAD_TOKEN;
  if (!expected) return false;
  const given = (request.headers.get("authorization") || "").replace(
    /^Bearer\s+/i,
    ""
  );
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// "Artist - Title.mp3" -> { artist, title }
function guessFromName(key) {
  const base = key.split("/").pop().replace(AUDIO_EXT, "");
  const parts = base.split(" - ");
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  }
  return { artist: "Unknown artist", title: base };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}
