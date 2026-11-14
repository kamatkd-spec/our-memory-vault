const crypto = require("crypto");

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 365 * 5; // 5 years

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function verifyPassword(password) {
  const stored = process.env.FAMILY_PASS_HASH || "";
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (!salt.length || !expected.length) return false;
  const derived = crypto.scryptSync(String(password || ""), salt, expected.length, { N, r, p });
  return safeEqual(derived, expected);
}

function signToken(claims) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const payload = Object.assign({ v: 1, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS }, claims || {});
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + sig;
}

function verifyToken(token) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function getTokenFromReq(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  if (typeof header === "string" && header.slice(0, 7).toLowerCase() === "bearer ") {
    return header.slice(7).trim();
  }
  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url, "https://" + host);
    return url.searchParams.get("token");
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res) {
  const payload = verifyToken(getTokenFromReq(req));
  if (!payload) {
    sendJson(res, 401, { error: "Unauthorized" });
    return null;
  }
  return payload;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(data);
}

function readJson(req, limit) {
  const max = limit || 4.5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error("Payload too large"), { code: "PAYLOAD_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error("Invalid JSON"), { code: "INVALID_JSON" }));
      }
    });
    req.on("error", reject);
  });
}

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || "unknown";
}

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 8;

function checkLoginRate(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now >= rec.reset) {
    loginAttempts.set(ip, { count: 1, reset: now + LOGIN_WINDOW_MS });
    return { ok: true, remaining: LOGIN_MAX - 1 };
  }
  rec.count += 1;
  if (rec.count > LOGIN_MAX) {
    return { ok: false, retryAfter: Math.ceil((rec.reset - now) / 1000) };
  }
  return { ok: true, remaining: LOGIN_MAX - rec.count };
}

function clearLoginRate(ip) {
  loginAttempts.delete(ip);
}

module.exports = {
  verifyPassword,
  signToken,
  verifyToken,
  getTokenFromReq,
  requireAuth,
  sendJson,
  readJson,
  clientIp,
  checkLoginRate,
  clearLoginRate,
  TOKEN_TTL_MS,
};
