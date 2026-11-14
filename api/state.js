const { requireAuth, sendJson, readJson } = require("../lib/auth");
const { loadState, saveState, nextState, normalizeState } = require("../lib/state");

module.exports = async function state(req, res) {
  if (req.method !== "GET" && req.method !== "PUT") {
    res.setHeader("Allow", "GET, PUT");
    return sendJson(res, 405, { error: "Method not allowed" });
  }
  if (!requireAuth(req, res)) return;

  try {
    if (req.method === "GET") {
      const current = await loadState();
      return sendJson(res, 200, current);
    }

    let body;
    try {
      body = await readJson(req, 4.5 * 1024 * 1024);
    } catch (e) {
      if (e && e.code === "PAYLOAD_TOO_LARGE") return sendJson(res, 413, { error: "Payload too large" });
      return sendJson(res, 400, { error: "Invalid JSON" });
    }
    const incoming = normalizeState(body);
    const current = await loadState();
    const conflict = Number(incoming.version) !== Number(current.version);
    const merged = nextState(current, incoming);
    await saveState(merged);
    return sendJson(res, 200, Object.assign({ conflict: !!conflict }, merged));
  } catch (err) {
    console.error("state error", err && err.message);
    return sendJson(res, 500, { error: "Could not save the vault" });
  }
};
