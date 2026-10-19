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
        return await listTracks(env);
      }
      if (path === "/api/web/search" && request.method === "GET") {
        return await cached(request, () => webSearch(url));
      }
      if (path.startsWith("/api/web/album/") && request.method === "GET") {
        const id = path.slice("/api/web/album/".length);
        return await cached(request, () => webAlbum(id));
      }
      if (path === "/api/web/tracks" && request.method === "GET") {
        return await cached(request, () => ccmTracks(url));
      }
      if (path.startsWith("/api/web/ccm/")) {
        return await ccmStream(request, url.pathname.slice("/api/web/ccm/".length));
      }
      if (path.startsWith("/api/stream/")) {
        const key = path.slice("/api/stream/".length);
        if (request.method === "GET" || request.method === "HEAD") {
          return await streamTrack(request, env, key);
        }
      }
      if (path.startsWith("/api/tracks/")) {
        const key = path.slice("/api/tracks/".length);
        if (request.method === "PUT") return await uploadTrack(request, env, key);
        if (request.method === "DELETE") return await deleteTrack(request, env, key);
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

// ---------- free music from the Internet Archive ----------
//
// Only two kinds of items are allowed, both free to stream:
//   netlabels: albums released under a Creative Commons license
//   etree:     live concert recordings the artists allow to be shared
// Audio streams straight from archive.org; nothing is stored here.

const IA = "https://archive.org";
const SOURCES = {
  netlabels: "(collection:netlabels AND mediatype:audio AND licenseurl:*creativecommons*)",
  live: "(collection:etree AND mediatype:etree)",
};
SOURCES.all = `(${SOURCES.netlabels} OR ${SOURCES.live})`;
const MP3_FORMATS = ["VBR MP3", "MP3", "128Kbps MP3", "64Kbps MP3"];
const PAGE_SIZE = 30;

async function webSearch(url) {
  const source = SOURCES[url.searchParams.get("source")] ? url.searchParams.get("source") : "all";
  const page = Math.max(1, Math.min(50, parseInt(url.searchParams.get("page"), 10) || 1));
  // Keep only plain words so user text can't change the query's meaning.
  const words = (url.searchParams.get("q") || "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(and|or|not)$/i.test(w))
    .slice(0, 8);

  let q = SOURCES[source];
  if (words.length) {
    const text = words.join(" ");
    q += ` AND (title:(${text}) OR creator:(${text}))`;
  }

  const params = new URLSearchParams({ q, rows: PAGE_SIZE, page, output: "json" });
  for (const f of ["identifier", "title", "creator", "year", "licenseurl", "collection"]) {
    params.append("fl[]", f);
  }
  params.append("sort[]", "downloads desc");

  const res = await fetch(`${IA}/advancedsearch.php?${params}`);
  if (!res.ok) throw new Error(`Internet Archive search failed (${res.status})`);
  const data = await res.json();

  const albums = data.response.docs.map((d) => ({
    id: d.identifier,
    title: d.title || d.identifier,
    artist: first(d.creator) || "Unknown artist",
    year: d.year || "",
    live: asList(d.collection).includes("etree"),
    license: d.licenseurl || "",
    cover: `${IA}/services/img/${encodeURIComponent(d.identifier)}`,
  }));
  return json({ albums, total: data.response.numFound, page, pageSize: PAGE_SIZE });
}

async function webAlbum(id) {
  if (!/^[\w.-]{1,100}$/.test(id)) return json({ error: "Bad album id" }, 400);

  const res = await fetch(`${IA}/metadata/${id}`);
  if (!res.ok) throw new Error(`Internet Archive lookup failed (${res.status})`);
  const data = await res.json();
  const m = data.metadata;
  if (!m) return json({ error: "Not found" }, 404);

  const collections = asList(m.collection);
  const freeAlbum =
    collections.includes("netlabels") && /creativecommons\.org/.test(m.licenseurl || "");
  const liveShow = collections.includes("etree");
  if (!freeAlbum && !liveShow) {
    return json({ error: "Only free netlabel albums and live recordings can be played" }, 403);
  }

  // Use the best MP3 set the item has.
  const files = data.files || [];
  const format = MP3_FORMATS.find((fmt) => files.some((f) => f.format === fmt));
  const artist = first(m.creator) || "Unknown artist";
  const album = first(m.title) || id;

  const tracks = files
    .filter((f) => f.format === format)
    .map((f) => ({
      key: `ia:${id}/${f.name}`,
      url: `${IA}/download/${id}/${f.name.split("/").map(encodeURIComponent).join("/")}`,
      title: f.title || f.name.replace(/\.mp3$/i, ""),
      artist: f.creator || artist,
      album,
      length: parseLength(f.length),
      n: parseInt(f.track, 10) || 0,
      name: f.name,
    }))
    .sort((a, b) => a.n - b.n || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map(({ n, name, ...t }) => t);

  return json({
    id,
    title: album,
    artist,
    year: m.year || m.date || "",
    live: liveShow,
    license: m.licenseurl || "",
    page: `${IA}/details/${id}`,
    cover: `${IA}/services/img/${encodeURIComponent(id)}`,
    tracks,
  });
}

// ---------- free singles from ccMixter ----------
//
// Every upload on ccMixter is Creative Commons licensed. Its file server
// refuses plays linked from other sites, so audio goes through
// /api/web/ccm/<path>, which only fetches ccmixter.org/content/ files.

const CCM = "https://ccmixter.org";
// Its API returns an empty body for pages bigger than about 15.
const CCM_PAGE = 15;

async function ccmTracks(url) {
  const page = Math.max(1, Math.min(50, parseInt(url.searchParams.get("page"), 10) || 1));
  const text = (url.searchParams.get("q") || "").replace(/[^\p{L}\p{N}\s'-]/gu, " ").trim().slice(0, 80);
  const params = new URLSearchParams({
    f: "json",
    sort: "rank",
    limit: CCM_PAGE,
    offset: (page - 1) * CCM_PAGE,
  });
  if (text) {
    params.set("search", text);
    params.set("search_type", "all");
  }

  const res = await fetch(`${CCM}/api/query?${params}`);
  const body = res.ok ? await res.text() : "";
  if (!body) throw new Error("ccMixter is not responding, try again");
  const uploads = JSON.parse(body);

  const tracks = [];
  for (const u of uploads) {
    const file = (u.files || []).find(
      (f) => f.file_format_info && f.file_format_info.mime_type === "audio/mpeg"
    );
    const m = file && /^https?:\/\/ccmixter\.org\/content\/(.+)$/.exec(file.download_url || "");
    if (!m) continue;
    tracks.push({
      key: `ccm:${u.upload_id}`,
      url: `/api/web/ccm/${m[1].split("/").map((p) => encodeURIComponent(safeDecode(p))).join("/")}`,
      title: u.upload_name,
      artist: u.user_name,
      album: "ccMixter",
      length: parseLength(file.file_format_info.ps),
      license: u.license_url || "",
      page: u.file_page_url || `${CCM}/files/${u.user_name}/${u.upload_id}`,
    });
  }
  return json({ tracks, page, pageSize: CCM_PAGE, more: uploads.length === CCM_PAGE });
}

async function ccmStream(request, path) {
  if (!/^[\w%.~+()!'*-]+(\/[\w%.~+()!'*-]+)*\.mp3$/i.test(path) || path.includes("..")) {
    return json({ error: "Bad path" }, 400);
  }
  const headers = { referer: `${CCM}/` };
  const range = request.headers.get("range");
  if (range) headers.range = range;

  const res = await fetch(`${CCM}/content/${path}`, { headers });
  if (!res.ok || !(res.headers.get("content-type") || "").startsWith("audio/")) {
    return json({ error: "Track not available" }, 502);
  }
  const out = new Headers({
    "content-type": res.headers.get("content-type"),
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=86400",
  });
  for (const h of ["content-length", "content-range", "etag", "last-modified"]) {
    if (res.headers.has(h)) out.set(h, res.headers.get(h));
  }
  return new Response(request.method === "HEAD" ? null : res.body, {
    status: res.status,
    headers: out,
  });
}

// Cache web lookups at the edge for an hour so repeat visits are fast.
async function cached(request, make) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await make();
  if (res.ok) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set("cache-control", "public, max-age=3600");
    await cache.put(request, copy);
  }
  return res;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function asList(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

// "240.9" or "4:00" -> seconds
function parseLength(v) {
  if (!v) return 0;
  if (String(v).includes(":")) {
    return String(v).split(":").reduce((s, p) => s * 60 + Number(p), 0);
  }
  return Number(v) || 0;
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
