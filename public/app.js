const $ = (id) => document.getElementById(id);
const audio = $("audio");

const state = {
  tracks: [],     // everything from the server
  view: [],       // tracks after search filter
  queue: [],      // play order (indexes into tracks)
  pos: -1,        // position in queue
  shuffle: false,
  repeat: false,
};

const store = {
  get(k, fallback) {
    try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch {}
  },
};

// ---------- loading ----------

async function loadTracks() {
  try {
    const res = await fetch("/api/tracks");
    if (!res.ok) throw new Error(`Server said ${res.status}`);
    const data = await res.json();
    const playingKey = currentTrack()?.key;
    state.tracks = data.tracks;
    state.queue = [];
    state.pos = -1;
    applySearch();
    // Keep next/prev working after the list reloads (e.g. after an upload).
    const i = state.tracks.findIndex((t) => t.key === playingKey);
    if (i >= 0) buildQueue(i);
    $("status").textContent = state.tracks.length
      ? `${state.tracks.length} songs`
      : "No songs yet. Use Upload to add some.";
  } catch (err) {
    $("status").textContent = `Could not load songs: ${err.message}`;
  }
}

function streamUrl(key) {
  return "/api/stream/" + key.split("/").map(encodeURIComponent).join("/");
}

// ---------- list ----------

function applySearch() {
  const q = $("search").value.trim().toLowerCase();
  state.view = state.tracks.filter((t) =>
    !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)
  );
  renderList();
}

function renderList() {
  const list = $("tracks");
  list.replaceChildren();
  const current = currentTrack();
  const canDelete = !!store.get("uploadToken", "");

  state.view.forEach((t, i) => {
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
    artist.textContent = t.album ? `${t.artist} · ${t.album}` : t.artist;
    info.append(title, artist);

    li.append(num, info);

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

    li.addEventListener("click", () => playFromView(i));
    list.append(li);
  });
}

// ---------- playback ----------

function currentTrack() {
  return state.pos >= 0 ? state.tracks[state.queue[state.pos]] : null;
}

function buildQueue(startTrackIndex) {
  // Queue is the visible list, so search acts as a playlist filter.
  const idx = state.view.map((t) => state.tracks.indexOf(t));
  if (state.shuffle) {
    const rest = idx.filter((i) => i !== startTrackIndex);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    state.queue = [startTrackIndex, ...rest];
    state.pos = 0;
  } else {
    state.queue = idx;
    state.pos = idx.indexOf(startTrackIndex);
  }
}

function playFromView(viewIndex) {
  buildQueue(state.tracks.indexOf(state.view[viewIndex]));
  playCurrent();
}

function playCurrent() {
  const t = currentTrack();
  if (!t) return;
  audio.src = streamUrl(t.key);
  audio.play().catch(() => {});
  $("nowTitle").textContent = t.title;
  $("nowArtist").textContent = t.artist;
  document.title = `${t.title} · SBK Music`;
  updateMediaSession(t);
  renderList();
}

function togglePlay() {
  if (!currentTrack()) {
    if (state.view.length) playFromView(0);
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
  if (t) buildQueue(state.tracks.indexOf(t));
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
$("search").addEventListener("input", applySearch);

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
function updateMediaSession(t) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album,
  });
}
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("nexttrack", next);
  navigator.mediaSession.setActionHandler("previoustrack", prev);
}

// ---------- upload / delete ----------

function authHeader() {
  return { authorization: `Bearer ${store.get("uploadToken", "")}` };
}

$("uploadToggle").addEventListener("click", () => {
  $("uploadPanel").hidden = !$("uploadPanel").hidden;
});
$("token").value = store.get("uploadToken", "");
$("token").addEventListener("change", () => {
  store.set("uploadToken", $("token").value.trim());
  renderList();
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
  loadTracks();
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
  loadTracks();
}

// ---------- start ----------

state.shuffle = !!store.get("shuffle", "");
state.repeat = !!store.get("repeat", "");
$("shuffle").setAttribute("aria-pressed", state.shuffle);
$("repeat").setAttribute("aria-pressed", state.repeat);
audio.volume = Number(store.get("volume", 1));
$("volume").value = audio.volume;
loadTracks();
