const { put, get, del } = require("@vercel/blob");

const STATE_PATH = "vault/state.json";
const PHOTO_PREFIX = "photos/";
const ACCESS = "private";

function emptyState() {
  return {
    version: 0,
    updatedAt: 0,
    notes: [],
    places: [],
    milestones: [],
    photos: [],
    settings: {
      years: { dating: "", anniversary: "", updatedAt: 0 },
      movingIn: { value: "", updatedAt: 0 },
      music: { url: "", updatedAt: 0 },
      icon: { icon180: null, icon512: null, updatedAt: 0 },
    },
    tombstones: { notes: {}, places: {}, milestones: {}, photos: {} },
  };
}

function blobOpts() {
  return { access: ACCESS, token: process.env.BLOB_READ_WRITE_TOKEN };
}

async function streamToBuffer(stream) {
  const res = new Response(stream);
  return Buffer.from(await res.arrayBuffer());
}

async function loadState() {
  try {
    const result = await get(STATE_PATH, { ...blobOpts(), useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return emptyState();
    const buf = await streamToBuffer(result.stream);
    const parsed = JSON.parse(buf.toString("utf8"));
    return normalizeState(parsed);
  } catch (err) {
    const msg = String(err && (err.message || err));
    if (err && (err.status === 404 || err.statusCode === 404 || /not found/i.test(msg))) {
      return emptyState();
    }
    throw err;
  }
}

async function saveState(state) {
  const body = JSON.stringify(state);
  await put(STATE_PATH, body, {
    ...blobOpts(),
    contentType: "application/json; charset=utf-8",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
  return state;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asMap(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function itemTime(item) {
  const n = Number(item && (item.updatedAt || item.createdAt) || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeItem(item) {
  if (!item || typeof item !== "object" || !item.id) return null;
  const copy = Object.assign({}, item);
  delete copy.dataUrl;
  if (!copy.createdAt) copy.createdAt = Date.now();
  if (!copy.updatedAt) copy.updatedAt = copy.createdAt;
  return copy;
}

function normalizeCollection(list) {
  const out = [];
  const seen = {};
  asArray(list).forEach((raw) => {
    const item = normalizeItem(raw);
    if (!item || seen[item.id]) return;
    seen[item.id] = true;
    out.push(item);
  });
  return out;
}

function normalizeSettings(s) {
  const src = s && typeof s === "object" ? s : {};
  const yearsIn = src.years && typeof src.years === "object" ? src.years : {};
  const movingIn = src.movingIn;
  const musicIn = src.music && typeof src.music === "object" ? src.music : {};
  const iconIn = src.icon && typeof src.icon === "object" ? src.icon : {};
  return {
    years: {
      dating: yearsIn.dating || "",
      anniversary: yearsIn.anniversary || "",
      updatedAt: Number(yearsIn.updatedAt || src.updatedAt || 0) || 0,
    },
    movingIn: {
      value: typeof movingIn === "string" ? movingIn : (movingIn && movingIn.value) || "",
      updatedAt: Number((movingIn && movingIn.updatedAt) || src.updatedAt || 0) || 0,
    },
    music: {
      url: musicIn.url || "",
      updatedAt: Number(musicIn.updatedAt || src.updatedAt || 0) || 0,
    },
    icon: {
      icon180: iconIn.icon180 || null,
      icon512: iconIn.icon512 || null,
      updatedAt: Number(iconIn.updatedAt || 0) || 0,
    },
  };
}

function normalizeTombstones(t) {
  const src = asMap(t);
  return {
    notes: asMap(src.notes),
    places: asMap(src.places),
    milestones: asMap(src.milestones),
    photos: asMap(src.photos),
  };
}

function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  base.version = Number(raw.version) || 0;
  base.updatedAt = Number(raw.updatedAt) || 0;
  base.notes = normalizeCollection(raw.notes);
  base.places = normalizeCollection(raw.places);
  base.milestones = normalizeCollection(raw.milestones);
  base.photos = normalizeCollection(raw.photos);
  base.settings = normalizeSettings(raw.settings);
  base.tombstones = normalizeTombstones(raw.tombstones);
  return base;
}

function mergeTombstones(a, b) {
  const keys = ["notes", "places", "milestones", "photos"];
  const out = { notes: {}, places: {}, milestones: {}, photos: {} };
  keys.forEach((k) => {
    const left = asMap(a[k]);
    const right = asMap(b[k]);
    const ids = new Set([...Object.keys(left), ...Object.keys(right)]);
    ids.forEach((id) => {
      out[k][id] = Math.max(Number(left[id] || 0), Number(right[id] || 0));
    });
  });
  return out;
}

function mergeCollection(serverList, incomingList, tombstones) {
  const map = {};
  normalizeCollection(serverList).forEach((item) => { map[item.id] = item; });
  normalizeCollection(incomingList).forEach((item) => {
    const prev = map[item.id];
    if (!prev || itemTime(item) >= itemTime(prev)) map[item.id] = item;
  });
  const stones = asMap(tombstones);
  Object.keys(stones).forEach((id) => {
    const t = Number(stones[id] || 0);
    const item = map[id];
    if (!item || t >= itemTime(item)) delete map[id];
  });
  return Object.keys(map).map((k) => map[k]);
}

function pickNewerField(serverField, incomingField) {
  const a = serverField || { updatedAt: 0 };
  const b = incomingField || { updatedAt: 0 };
  return (Number(b.updatedAt) || 0) >= (Number(a.updatedAt) || 0) ? b : a;
}

function mergeSettings(server, incoming) {
  return {
    years: pickNewerField(server.years, incoming.years),
    movingIn: pickNewerField(server.movingIn, incoming.movingIn),
    music: pickNewerField(server.music, incoming.music),
    icon: pickNewerField(server.icon, incoming.icon),
  };
}

function mergeStates(server, incoming) {
  const a = normalizeState(server);
  const b = normalizeState(incoming);
  const tombstones = mergeTombstones(a.tombstones, b.tombstones);
  return {
    version: Math.max(a.version, b.version),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    notes: mergeCollection(a.notes, b.notes, tombstones.notes),
    places: mergeCollection(a.places, b.places, tombstones.places),
    milestones: mergeCollection(a.milestones, b.milestones, tombstones.milestones),
    photos: mergeCollection(a.photos, b.photos, tombstones.photos),
    settings: mergeSettings(a.settings, b.settings),
    tombstones,
  };
}

function nextState(server, incoming) {
  const current = normalizeState(server);
  const proposed = normalizeState(incoming);
  let merged;
  if (Number(proposed.version) === Number(current.version)) {
    // Client was up to date: take its collections, still merge tombstones so
    // a delete from another in-flight request is not lost.
    const tombstones = mergeTombstones(current.tombstones, proposed.tombstones);
    merged = {
      version: current.version,
      notes: mergeCollection(proposed.notes, [], tombstones.notes),
      places: mergeCollection(proposed.places, [], tombstones.places),
      milestones: mergeCollection(proposed.milestones, [], tombstones.milestones),
      photos: mergeCollection(proposed.photos, [], tombstones.photos),
      settings: proposed.settings,
      tombstones,
    };
  } else {
    merged = mergeStates(current, proposed);
  }
  merged.version = (Number(current.version) || 0) + 1;
  merged.updatedAt = Date.now();
  return merged;
}

function photoPath(id) {
  return PHOTO_PREFIX + String(id) + ".jpg";
}

async function putPhoto(id, buffer, contentType) {
  return put(photoPath(id), buffer, {
    ...blobOpts(),
    contentType: contentType || "image/jpeg",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60 * 60 * 24 * 30,
  });
}

async function getPhoto(id) {
  return get(photoPath(id), blobOpts());
}

async function deletePhotoBlob(id) {
  try {
    await del(photoPath(id), { token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch (err) {
    const msg = String(err && (err.message || err));
    if (err && (err.status === 404 || err.statusCode === 404 || /not found/i.test(msg))) return;
    throw err;
  }
}

module.exports = {
  STATE_PATH,
  emptyState,
  loadState,
  saveState,
  normalizeState,
  mergeStates,
  nextState,
  photoPath,
  putPhoto,
  getPhoto,
  deletePhotoBlob,
  streamToBuffer,
};
