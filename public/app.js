const $ = (id) => document.getElementById(id);
const audio = $("audio");

const state = {
  source: "netlabels", // netlabels | live | singles | mine
  query: "",
  page: 1,
  albums: [],     // album cards on screen
  album: null,    // open album, if any
  list: [],       // tracks on screen
  queue: [],      // tracks queued for playback (snapshot of a list)
  pos: -1,
  shuffle: false,
  repeat: false,
  mine: [],       // uploaded tracks
};

const store = {
  get(k, fallback) {
    try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch {}
  },
};

async function getJSON(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server said ${res.status}`);
  return data;
}

function setStatus(text) {
  $("status").textContent = text;
  $("status").hidden = !text;
}

// ---------- browsing ----------

let loadId = 0;

async function load(append = false) {
  const id = ++loadId;
  if (!append) {
    state.page = 1;
    state.albums = [];
    state.list = [];
    state.album = null;
    render();
  }
  setStatus("Loading…");
  $("more").hidden = true;

  const q = encodeURIComponent(state.query);
  try {
    if (state.source === "mine") {
      state.list = filterMine();
      setStatus(state.list.length ? "" : "No uploads match.");
    } else if (state.source === "soundcloud") {
      state.list = filterSaved(loadSaved());
      setStatus(state.list.length ? "" : state.query
        ? "No saved SoundCloud links match."
        : "Paste a SoundCloud link above to add it. It plays the full song in SoundCloud's player.");
    } else if (state.source === "popular") {
      const tracks = await popular(state.query);
      if (id !== loadId) return;
      state.list = tracks;
      setStatus(state.list.length ? "" : "Nothing found.");
    } else if (state.source === "singles") {
      const data = await getJSON(`/api/web/tracks?q=${q}&page=${state.page}`);
      if (id !== loadId) return;
      state.list = state.list.concat(data.tracks);
      $("more").hidden = !data.more;
      setStatus(state.list.length ? "" : "Nothing found.");
    } else {
      const data = await getJSON(`/api/web/search?source=${state.source}&q=${q}&page=${state.page}`);
      if (id !== loadId) return;
      state.albums = state.albums.concat(data.albums);
      $("more").hidden = state.albums.length >= data.total;
      setStatus(state.albums.length ? "" : "Nothing found.");
    }
  } catch (err) {
    if (id === loadId) setStatus(`Could not load: ${err.message}`);
  }
  if (id === loadId) render();
}

async function openAlbum(a) {
  const id = ++loadId;
  state.album = { ...a, tracks: [] };
  state.list = [];
  render();
  setStatus("Loading tracks…");
  try {
    const data = await getJSON(`/api/web/album/${encodeURIComponent(a.id)}`);
    if (id !== loadId) return;
    state.album = data;
    state.list = data.tracks;
    setStatus(data.tracks.length ? "" : "This album has no playable tracks.");
  } catch (err) {
    if (id === loadId) setStatus(`Could not load album: ${err.message}`);
  }
  if (id === loadId) render();
  window.scrollTo(0, 0);
}

function closeAlbum() {
  state.album = null;
  state.list = [];
  ++loadId;
  setStatus(state.albums.length ? "" : "Nothing found.");
  $("more").hidden = state.albums.length === 0;
  render();
}

function filterMine() {
  return filterSaved(state.mine);
}

function filterSaved(list) {
  const q = state.query.toLowerCase();
  return list.filter((t) =>
    !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)
  );
}

// ---------- popular songs (official 30-second previews) ----------
//
// Ask Apple from the browser so each listener has their own rate limit;
// Apple throttles shared cloud addresses. The Worker is the fallback.

async function popular(query) {
  try {
    return query ? await itunesSearch(query) : await itunesChart();
  } catch {
    const data = await getJSON(`/api/web/popular?q=${encodeURIComponent(query)}`);
    return data.tracks;
  }
}

async function itunesSearch(text) {
  const params = new URLSearchParams({
    term: text, media: "music", entity: "song", limit: 50, country: "us",
  });
  const res = await fetch(`https://itunes.apple.com/search?${params}`);
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  return data.results.filter((r) => r.previewUrl).map((r) => ({
    key: `it:${r.trackId}`,
    url: r.previewUrl,
    title: r.trackName,
    artist: r.artistName,
    album: r.collectionName || "",
    cover: (r.artworkUrl100 || "").replace("100x100bb", "600x600bb"),
    page: r.trackViewUrl,
    length: 30,
    preview: true,
  }));
}

async function itunesChart() {
  const res = await fetch("https://itunes.apple.com/us/rss/topsongs/limit=100/json");
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const tracks = [];
  for (const e of (data.feed && data.feed.entry) || []) {
    const links = list(e.link).map((l) => l.attributes || {});
    const audioLink = links.find((l) => (l.type || "").startsWith("audio"));
    if (!audioLink) continue;
    const page = links.find((l) => l.rel === "alternate");
    const images = list(e["im:image"]);
    tracks.push({
      key: `it:${e.id.attributes["im:id"]}`,
      url: audioLink.href,
      title: e["im:name"].label,
      artist: e["im:artist"].label,
      album: (e["im:collection"] && e["im:collection"]["im:name"].label) || "",
      cover: images.length ? images[images.length - 1].label.replace(/\d+x\d+bb/, "600x600bb") : "",
      page: page ? page.href : "",
      length: 30,
      preview: true,
    });
  }
  return tracks;
}

// ---------- saved SoundCloud links (kept in this browser) ----------

function loadSaved() {
  try { return JSON.parse(store.get("soundcloud", "[]")) || []; } catch { return []; }
}

function saveSaved(list) {
  store.set("soundcloud", JSON.stringify(list));
}

$("scAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("scUrl");
  const link = input.value.trim();
  if (!link) return;
  setStatus("Looking up link…");
  try {
    const t = await getJSON(`/api/web/soundcloud?url=${encodeURIComponent(link)}`);
    const saved = loadSaved().filter((x) => x.key !== t.key);
    saved.unshift(t);
    saveSaved(saved);
    input.value = "";
    load();
  } catch (err) {
    setStatus(err.message);
  }
});

function removeSaved(t) {
  saveSaved(loadSaved().filter((x) => x.key !== t.key));
  load();
}

// ---------- rendering ----------

function render() {
  const showAlbums = !state.album && (state.source === "netlabels" || state.source === "live");
  $("albums").hidden = !showAlbums;
  $("albums").replaceChildren(...(showAlbums ? state.albums.map(albumCard) : []));

  const head = $("albumHead");
  head.hidden = !state.album;
  if (state.album) {
    const a = state.album;
    $("albumCover").src = a.cover;
    $("albumTitle").textContent = a.title;
    $("albumArtist").textContent = [a.artist, a.year].filter(Boolean).join(" · ");
    $("albumLicense").hidden = !a.license;
    $("albumLicense").href = a.license || "#";
    $("albumLicense").textContent = a.live ? "Live recording" : "License";
    $("albumPage").href = a.page || "#";
    $("albumPage").hidden = !a.page;
    $("more").hidden = true;
  }

  $("scAdd").hidden = state.source !== "soundcloud";
  const note = {
    popular: state.query
      ? "Official 30-second previews. Tap “Full song” to hear the whole track on Apple Music."
      : "Top songs right now. Official 30-second previews; tap “Full song” for the whole track.",
    soundcloud: "Full songs, played in SoundCloud's player. Some major-label songs only play a preview, depending on the label.",
  }[state.source];
  $("note").hidden = !note || !!state.album;
  $("note").textContent = note || "";
  $("search").placeholder = {
    popular: "Search any artist or song",
    soundcloud: "Filter saved links",
    mine: "Filter uploads",
  }[state.source] || "Search free music";

  renderTracks();
  document.querySelectorAll(".chips button").forEach((b) =>
    b.setAttribute("aria-pressed", b.dataset.source === state.source)
  );
}

function albumCard(a) {
  const card = document.createElement("button");
  card.className = "album";
  const img = document.createElement("img");
  img.src = a.cover;
  img.alt = "";
  img.loading = "lazy";
  const title = document.createElement("div");
  title.className = "t";
  title.textContent = a.title;
  const artist = document.createElement("div");
  artist.className = "a";
  artist.textContent = [a.artist, a.year].filter(Boolean).join(" · ");
  card.append(img, title, artist);
  card.addEventListener("click", () => openAlbum(a));
  return card;
}

function renderTracks() {
  const list = $("tracks");
  list.replaceChildren();
  const current = currentTrack();
  const canDelete =
    (state.source === "mine" && !!store.get("uploadToken", "")) ||
    state.source === "soundcloud";

  state.list.forEach((t, i) => {
    const li = document.createElement("li");
    if (current && current.key === t.key) li.classList.add("playing");

    let num;
    if (t.cover && !state.album) {
      num = document.createElement("img");
      num.className = "thumb";
      num.src = t.cover;
      num.alt = "";
      num.loading = "lazy";
    } else {
      num = document.createElement("span");
      num.className = "num";
      num.textContent = i + 1;
    }

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "t";
    title.textContent = t.title;
    if (t.preview || t.playlist) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = t.preview ? "Preview" : "Playlist";
      title.append(badge);
    }
    const artist = document.createElement("div");
    artist.className = "a";
    artist.textContent = state.album || !t.album ? t.artist : `${t.artist} · ${t.album}`;
    info.append(title, artist);

    const end = document.createElement("span");
    end.className = "len";
    end.textContent = t.length ? fmt(t.length) : "";

    li.append(num, info, end);

    if (t.page && (t.preview || t.sc)) {
      const ext = document.createElement("a");
      ext.className = "ext";
      ext.href = t.page;
      ext.target = "_blank";
      ext.rel = "noopener";
      ext.textContent = t.preview ? "Full song ↗" : "SoundCloud ↗";
      ext.addEventListener("click", (e) => e.stopPropagation());
      li.append(ext);
    }

    if (canDelete) {
      const del = document.createElement("button");
      del.className = "del";
      del.title = t.sc ? "Remove" : "Delete";
      del.textContent = "✕";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        t.sc ? removeSaved(t) : deleteTrack(t);
      });
      li.append(del);
    }

    li.addEventListener("click", () => playList(i));
    list.append(li);
  });
}

// ---------- playback ----------

function currentTrack() {
  return state.pos >= 0 ? state.queue[state.pos] : null;
}

function trackUrl(t) {
  return t.url || "/api/stream/" + t.key.split("/").map(encodeURIComponent).join("/");
}

function playList(start) {
  const tracks = state.list.slice();
  if (state.shuffle) {
    const first = tracks.splice(start, 1)[0];
    shuffleInPlace(tracks);
    state.queue = [first, ...tracks];
    state.pos = 0;
  } else {
    state.queue = tracks;
    state.pos = start;
  }
  playCurrent();
}

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function playCurrent() {
  const t = currentTrack();
  if (!t) return;
  if (t.sc) {
    // Stop the normal player without triggering its error handler.
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    playSoundCloud(t);
  } else {
    stopSoundCloud();
    audio.src = trackUrl(t);
    audio.play().catch(() => {});
  }
  $("nowTitle").textContent = t.title;
  $("nowArtist").textContent = t.artist;
  document.title = `${t.title} · SBK Music`;
  if ("mediaSession" in navigator) {
    const cover = t.cover || (state.album && state.album.cover);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album || "",
      artwork: cover ? [{ src: cover }] : [],
    });
  }
  renderTracks();
}

function onSoundCloud() {
  const t = currentTrack();
  return !!(t && t.sc && sc.widget);
}

function togglePlay() {
  if (!currentTrack()) {
    if (state.list.length) playList(0);
    return;
  }
  if (onSoundCloud()) sc.widget.toggle();
  else audio.paused ? audio.play() : audio.pause();
}

// ---------- SoundCloud widget ----------
//
// SoundCloud songs play in SoundCloud's own embedded player (their terms
// don't allow anything else). Our buttons drive it through the Widget API.

const sc = { widget: null, api: null, pos: 0, dur: 0 };

function loadScApi() {
  if (!sc.api) {
    sc.api = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://w.soundcloud.com/player/api.js";
      s.onload = () => resolve(window.SC);
      s.onerror = () => { sc.api = null; reject(new Error("Couldn't load SoundCloud")); };
      document.head.append(s);
    });
  }
  return sc.api;
}

const SC_OPTIONS = {
  auto_play: true, visual: false, show_comments: false,
  hide_related: true, show_teaser: false, show_reposts: false,
};

async function playSoundCloud(t) {
  $("scWidget").hidden = false;
  document.body.classList.add("sc-on");
  let SC;
  try {
    SC = await loadScApi();
  } catch (err) {
    setStatus(err.message);
    return;
  }
  if (currentTrack() !== t) return;

  sc.pos = 0;
  sc.dur = 0;
  if (sc.widget) {
    sc.widget.load(t.sc, { ...SC_OPTIONS, callback: () => sc.widget.setVolume(audio.volume * 100) });
    return;
  }

  const frame = document.createElement("iframe");
  frame.allow = "autoplay; encrypted-media";
  frame.title = "SoundCloud player";
  frame.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(t.sc)}&${new URLSearchParams(SC_OPTIONS)}`;
  $("scWidget").append(frame);

  const w = SC.Widget(frame);
  sc.widget = w;
  const E = SC.Widget.Events;
  w.bind(E.READY, () => w.setVolume(audio.volume * 100));
  w.bind(E.PLAY, () => {
    if (onSoundCloud()) $("play").textContent = "⏸";
    w.getDuration((d) => { sc.dur = d; $("dur").textContent = fmt(d / 1000); });
  });
  w.bind(E.PAUSE, () => { if (onSoundCloud()) $("play").textContent = "▶"; });
  w.bind(E.PLAY_PROGRESS, (e) => {
    if (!onSoundCloud()) return;
    sc.pos = e.currentPosition;
    $("cur").textContent = fmt(sc.pos / 1000);
    if (!seeking && sc.dur) $("seek").value = Math.round((sc.pos / sc.dur) * 1000);
  });
  w.bind(E.FINISH, () => {
    if (!onSoundCloud()) return;
    // A playlist moves through its own songs; go on once its last one ends.
    if (!currentTrack().playlist) return next();
    w.getSounds((sounds) => w.getCurrentSoundIndex((i) => {
      if (i >= sounds.length - 1) next();
    }));
  });
}

function stopSoundCloud() {
  if (sc.widget) sc.widget.pause();
  $("scWidget").hidden = true;
  document.body.classList.remove("sc-on");
}

function next() {
  if (!state.queue.length) return;
  if (state.pos < state.queue.length - 1) state.pos++;
  else if (state.repeat) state.pos = 0;
  else return;
  playCurrent();
}

function prev() {
  if (!state.queue.length) return;
  // Restart the song if we're more than 3s in, like most players.
  const at = onSoundCloud() ? sc.pos / 1000 : audio.currentTime;
  if (at > 3 || state.pos === 0) {
    if (onSoundCloud()) sc.widget.seekTo(0);
    else audio.currentTime = 0;
    return;
  }
  state.pos--;
  playCurrent();
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  $("shuffle").setAttribute("aria-pressed", state.shuffle);
  store.set("shuffle", state.shuffle ? "1" : "");
  const t = currentTrack();
  if (t && state.shuffle) {
    const rest = state.queue.filter((x) => x !== t);
    shuffleInPlace(rest);
    state.queue = [t, ...rest];
    state.pos = 0;
  }
}

function toggleRepeat() {
  state.repeat = !state.repeat;
  $("repeat").setAttribute("aria-pressed", state.repeat);
  store.set("repeat", state.repeat ? "1" : "");
}

function fmt(sec) {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

let seeking = false;
audio.addEventListener("timeupdate", () => {
  if (onSoundCloud()) return;
  $("cur").textContent = fmt(audio.currentTime);
  if (!seeking && audio.duration) {
    $("seek").value = Math.round((audio.currentTime / audio.duration) * 1000);
  }
});
audio.addEventListener("loadedmetadata", () => {
  if (onSoundCloud()) return;
  $("dur").textContent = fmt(audio.duration);
});
audio.addEventListener("play", () => { if (!onSoundCloud()) $("play").textContent = "⏸"; });
audio.addEventListener("pause", () => { if (!onSoundCloud()) $("play").textContent = "▶"; });
audio.addEventListener("ended", next);
// Skip tracks that fail to load instead of stopping.
audio.addEventListener("error", () => {
  const t = currentTrack();
  if (t && !t.sc && audio.getAttribute("src")) setTimeout(next, 500);
});

$("seek").addEventListener("input", () => { seeking = true; });
$("seek").addEventListener("change", () => {
  const frac = $("seek").value / 1000;
  if (onSoundCloud()) { if (sc.dur) sc.widget.seekTo(frac * sc.dur); }
  else if (audio.duration) audio.currentTime = frac * audio.duration;
  seeking = false;
});
$("volume").addEventListener("input", () => {
  audio.volume = $("volume").value;
  if (sc.widget) sc.widget.setVolume(audio.volume * 100);
  store.set("volume", audio.volume);
});

$("play").addEventListener("click", togglePlay);
$("next").addEventListener("click", next);
$("prev").addEventListener("click", prev);
$("shuffle").addEventListener("click", toggleShuffle);
$("repeat").addEventListener("click", toggleRepeat);
$("back").addEventListener("click", closeAlbum);
$("playAll").addEventListener("click", () => state.list.length && playList(0));
$("more").addEventListener("click", () => { state.page++; load(true); });

document.querySelectorAll(".chips button").forEach((b) =>
  b.addEventListener("click", () => {
    state.source = b.dataset.source;
    store.set("source", state.source);
    load();
  })
);

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = $("search").value.trim();
    load();
  }, 400);
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input")) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowRight") next();
  else if (e.key === "ArrowLeft") prev();
  else if (e.key === "s") toggleShuffle();
  else if (e.key === "r") toggleRepeat();
  else if (e.key === "/") { e.preventDefault(); $("search").focus(); }
});

// Lock screen / headphone controls.
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => onSoundCloud() ? sc.widget.play() : audio.play());
  navigator.mediaSession.setActionHandler("pause", () => onSoundCloud() ? sc.widget.pause() : audio.pause());
  navigator.mediaSession.setActionHandler("nexttrack", next);
  navigator.mediaSession.setActionHandler("previoustrack", prev);
}

// ---------- uploads ----------

async function loadMine() {
  try {
    const data = await getJSON("/api/tracks");
    state.mine = data.tracks;
  } catch {
    state.mine = [];
  }
  document.querySelector('[data-source="mine"]').hidden = state.mine.length === 0;
  if (state.source === "mine") {
    if (state.mine.length) load();
    else { state.source = "netlabels"; load(); }
  }
}

function authHeader() {
  return { authorization: `Bearer ${store.get("uploadToken", "")}` };
}

$("uploadToggle").addEventListener("click", () => {
  $("uploadPanel").hidden = !$("uploadPanel").hidden;
});
$("token").value = store.get("uploadToken", "");
$("token").addEventListener("change", () => {
  store.set("uploadToken", $("token").value.trim());
  renderTracks();
});

$("files").addEventListener("change", () => uploadFiles($("files").files));
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  uploadFiles(e.dataTransfer.files);
});

async function uploadFiles(files) {
  if (!store.get("uploadToken", "")) {
    alert("Enter your upload token first.");
    return;
  }
  for (const file of files) {
    const li = document.createElement("li");
    li.textContent = `Uploading ${file.name}…`;
    $("uploadList").prepend(li);
    if (file.size > 25 * 1024 * 1024) {
      li.textContent = `✕ ${file.name}: over 25 MB`;
      continue;
    }

    const base = file.name.replace(/\.[^.]+$/, "");
    const [artist, ...rest] = base.split(" - ");
    const headers = {
      ...authHeader(),
      "content-type": file.type || "audio/mpeg",
      "x-title": encodeURIComponent(rest.length ? rest.join(" - ") : base),
      "x-artist": encodeURIComponent(rest.length ? artist : "Unknown artist"),
    };

    try {
      const res = await fetch(`/api/tracks/${encodeURIComponent(file.name)}`, {
        method: "PUT", headers, body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      li.textContent = `✓ ${file.name}`;
    } catch (err) {
      li.textContent = `✕ ${file.name}: ${err.message}`;
    }
  }
  $("files").value = "";
  loadMine();
}

async function deleteTrack(t) {
  if (!confirm(`Delete "${t.title}" for everyone? This can't be undone.`)) return;
  const res = await fetch(`/api/tracks/${encodeURIComponent(t.key)}`, {
    method: "DELETE", headers: authHeader(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(`Delete failed: ${data.error || res.status}`);
    return;
  }
  loadMine();
}

// ---------- start ----------

state.shuffle = !!store.get("shuffle", "");
state.repeat = !!store.get("repeat", "");
$("shuffle").setAttribute("aria-pressed", state.shuffle);
$("repeat").setAttribute("aria-pressed", state.repeat);
audio.volume = Number(store.get("volume", 1));
$("volume").value = audio.volume;
const saved = store.get("source", "netlabels");
state.source = ["netlabels", "live", "singles", "popular", "soundcloud", "mine"].includes(saved) ? saved : "netlabels";
load();
loadMine();
