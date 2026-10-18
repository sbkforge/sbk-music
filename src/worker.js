// sbk-music Worker: lists tracks, streams audio from R2, and handles
// token-protected uploads and deletes. Static files come from ./public.

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm)$/i;

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
    const page = await env.MUSIC.list({ cursor, include: ["customMetadata"] });
    for (const obj of page.objects) {
      if (!AUDIO_EXT.test(obj.key)) continue;
      const meta = obj.customMetadata || {};
      const guess = guessFromName(obj.key);
      tracks.push({
        key: obj.key,
        title: meta.title || guess.title,
        artist: meta.artist || guess.artist,
        album: meta.album || "",
        size: obj.size,
        uploaded: obj.uploaded,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  tracks.sort((a, b) =>
    (a.artist + a.title).localeCompare(b.artist + b.title)
  );
  return json({ tracks }, 200, { "cache-control": "no-store" });
}

async function streamTrack(request, env, key) {
  // Passing the request headers lets R2 handle Range and If-None-Match.
  const obj = await env.MUSIC.get(key, {
    range: request.headers,
    onlyIf: request.headers,
  });
  if (obj === null) return json({ error: "Not found" }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=86400");

  // onlyIf matched an existing copy: body is absent.
  if (!("body" in obj)) return new Response(null, { status: 304, headers });

  let status = 200;
  if (request.headers.has("range") && obj.range) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + length - 1}/${obj.size}`
    );
    headers.set("content-length", String(length));
    status = 206;
  } else {
    headers.set("content-length", String(obj.size));
  }

  const body = request.method === "HEAD" ? null : obj.body;
  return new Response(body, { status, headers });
}

async function uploadTrack(request, env, key) {
  if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
  if (!key || !AUDIO_EXT.test(key) || key.includes("..")) {
    return json({ error: "Use an audio file name like song.mp3" }, 400);
  }

  const h = request.headers;
  const customMetadata = {};
  for (const field of ["title", "artist", "album"]) {
    const value = h.get(`x-${field}`);
    if (value) customMetadata[field] = decodeURIComponent(value).slice(0, 200);
  }

  await env.MUSIC.put(key, request.body, {
    httpMetadata: { contentType: h.get("content-type") || "audio/mpeg" },
    customMetadata,
  });
  return json({ ok: true, key }, 201);
}

async function deleteTrack(request, env, key) {
  if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
  await env.MUSIC.delete(key);
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
