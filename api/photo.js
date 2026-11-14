const { Readable } = require("stream");
const { requireAuth, sendJson, readJson, getTokenFromReq } = require("../lib/auth");
const { loadState, saveState, nextState, putPhoto, getPhoto, deletePhotoBlob, streamToBuffer } = require("../lib/state");

function photoIdFromReq(req, body) {
  if (body && body.id) return String(body.id);
  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url, "https://" + host);
    return url.searchParams.get("id") || "";
  } catch (e) {
    return "";
  }
}

function decodeImage(image) {
  if (!image || typeof image !== "string") return null;
  let b64 = image;
  const comma = image.indexOf("base64,");
  if (image.startsWith("data:") && comma !== -1) b64 = image.slice(comma + 7);
  try {
    const buf = Buffer.from(b64, "base64");
    if (!buf.length) return null;
    return buf;
  } catch (e) {
    return null;
  }
}

function isJpeg(buf) {
  return buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

module.exports = async function photo(req, res) {
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
    res.setHeader("Allow", "GET, POST, DELETE");
    return sendJson(res, 405, { error: "Method not allowed" });
  }
  if (!requireAuth(req, res)) return;

  try {
    if (req.method === "GET") {
      const id = photoIdFromReq(req, null);
      if (!id) return sendJson(res, 400, { error: "Missing photo id" });
      const result = await getPhoto(id);
      if (!result || result.statusCode !== 200 || !result.stream) {
        return sendJson(res, 404, { error: "Photo not found" });
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", result.blob.contentType || "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (typeof Readable.fromWeb === "function") {
        Readable.fromWeb(result.stream).pipe(res);
      } else {
        const buf = await streamToBuffer(result.stream);
        res.end(buf);
      }
      return;
    }

    if (req.method === "POST") {
      let body;
      try {
        body = await readJson(req, 4.5 * 1024 * 1024);
      } catch (e) {
        if (e && e.code === "PAYLOAD_TOO_LARGE") return sendJson(res, 413, { error: "Photo is too large" });
        return sendJson(res, 400, { error: "Invalid JSON" });
      }
      const id = String((body && body.id) || "").trim();
      const buf = decodeImage(body && body.image);
      if (!id || !buf) return sendJson(res, 400, { error: "Missing photo data" });
      if (buf.length > 3.5 * 1024 * 1024) return sendJson(res, 413, { error: "Photo is too large" });
      if (!isJpeg(buf)) return sendJson(res, 400, { error: "Please upload a JPEG photo" });
      const metaIn = (body.meta && typeof body.meta === "object") ? body.meta : {};
      const meta = Object.assign({}, metaIn, { id: id });
      delete meta.dataUrl;
      meta.updatedAt = Number(meta.updatedAt) || Date.now();
      meta.createdAt = Number(meta.createdAt) || meta.updatedAt;
      await putPhoto(id, buf, "image/jpeg");

      const current = await loadState();
      const incoming = {
        version: current.version,
        photos: current.photos.filter((p) => p.id !== id).concat([meta]),
        notes: current.notes,
        places: current.places,
        milestones: current.milestones,
        settings: current.settings,
        tombstones: current.tombstones,
      };
      // Drop a stale photo tombstone if we are putting this id back.
      if (incoming.tombstones && incoming.tombstones.photos) {
        incoming.tombstones = Object.assign({}, incoming.tombstones, {
          photos: Object.assign({}, incoming.tombstones.photos),
        });
        delete incoming.tombstones.photos[id];
      }
      const merged = nextState(current, incoming);
      await saveState(merged);
      const saved = (merged.photos || []).find((p) => p.id === id) || meta;
      return sendJson(res, 200, { ok: true, photo: saved, version: merged.version, state: merged });
    }

    // DELETE
    let body = {};
    try {
      if (Number(req.headers["content-length"] || 0) > 0) body = await readJson(req, 32 * 1024);
    } catch (e) {
      body = {};
    }
    const id = photoIdFromReq(req, body);
    if (!id) return sendJson(res, 400, { error: "Missing photo id" });
    await deletePhotoBlob(id);
    const current = await loadState();
    const now = Date.now();
    const incoming = {
      version: current.version,
      photos: current.photos.filter((p) => p.id !== id),
      notes: current.notes,
      places: current.places,
      milestones: current.milestones,
      settings: current.settings,
      tombstones: current.tombstones,
    };
    incoming.tombstones = Object.assign({}, incoming.tombstones, {
      photos: Object.assign({}, (incoming.tombstones && incoming.tombstones.photos) || {}, { [id]: now }),
    });
    const merged = nextState(current, incoming);
    await saveState(merged);
    return sendJson(res, 200, { ok: true, version: merged.version, state: merged });
  } catch (err) {
    console.error("photo error", err && err.message);
    return sendJson(res, 500, { error: "Could not handle the photo" });
  }
};
