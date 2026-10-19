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
  const q = state.query.toLowerCase();
  return state.mine.filter((t) =>
    !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)
  );
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
  const canDelete = state.source === "mine" && !!store.get("uploadToken", "");

  state.list.forEach((t, i) => {
    const li = document.createElement("li");
    if (current && current.key === t.key) li.classList.add("playing");

    const num = document.createElement("span");
    num.className = "num";
    num.textContent = i + 1;

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "t";
    title.textContent = t.title;
    const artist = document.createElement("div");
    artist.className = "a";
    artist.textContent = state.album || !t.album ? t.artist : `${t.artist} · ${t.album}`;
    info.append(title, artist);

    const end = document.createElement("span");
    end.className = "len";
    end.textContent = t.length ? fmt(t.length) : "";

    li.append(num, info, end);

    if (canDelete) {
      const del = document.createElement("button");
      del.className = "del";
      del.title = "Delete";
      del.textContent = "✕";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteTrack(t);
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
  audio.src = trackUrl(t);
  audio.play().catch(() => {});
  $("nowTitle").textContent = t.title;
  $("nowArtist").textContent = t.artist;
  document.title = `${t.title} · SBK Music`;
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album || "",
      artwork: state.album && state.album.cover ? [{ src: state.album.cover }] : [],
    });
  }
  renderTracks();
}

function togglePlay() {
  if (!currentTrack()) {
    if (state.list.length) playList(0);
    return;
  }
  audio.paused ? audio.play() : audio.pause();
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
  if (audio.currentTime > 3 || state.pos === 0) {
    audio.currentTime = 0;
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
  $("cur").textContent = fmt(audio.currentTime);
  if (!seeking && audio.duration) {
    $("seek").value = Math.round((audio.currentTime / audio.duration) * 1000);
  }
});
audio.addEventListener("loadedmetadata", () => {
  $("dur").textContent = fmt(audio.duration);
});
audio.addEventListener("play", () => { $("play").textContent = "⏸"; });
audio.addEventListener("pause", () => { $("play").textContent = "▶"; });
audio.addEventListener("ended", next);
// Skip tracks that fail to load instead of stopping.
audio.addEventListener("error", () => {
  if (currentTrack()) setTimeout(next, 500);
});

$("seek").addEventListener("input", () => { seeking = true; });
$("seek").addEventListener("change", () => {
  if (audio.duration) audio.currentTime = ($("seek").value / 1000) * audio.duration;
  seeking = false;
});
$("volume").addEventListener("input", () => {
  audio.volume = $("volume").value;
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
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
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
state.source = ["netlabels", "live", "singles", "mine"].includes(saved) ? saved : "netlabels";
load();
loadMine();
