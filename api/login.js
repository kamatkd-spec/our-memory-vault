const { verifyPassword, signToken, sendJson, readJson, clientIp, checkLoginRate, clearLoginRate } = require("../lib/auth");

module.exports = async function login(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed" });
  }
  if (!process.env.FAMILY_PASS_HASH || !process.env.SESSION_SECRET) {
    return sendJson(res, 500, { error: "Server is not configured" });
  }

  const ip = clientIp(req);
  const rate = checkLoginRate(ip);
  if (!rate.ok) {
    res.setHeader("Retry-After", String(rate.retryAfter));
    return sendJson(res, 429, { error: "Too many attempts. Please wait and try again." });
  }

  let body;
  try {
    body = await readJson(req, 8 * 1024);
  } catch (e) {
    return sendJson(res, 400, { error: "Invalid request" });
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!password || !verifyPassword(password)) {
    return sendJson(res, 401, { error: "Wrong password" });
  }
  clearLoginRate(ip);
  const token = signToken({ typ: "family" });
  return sendJson(res, 200, { token, ok: true });
};
