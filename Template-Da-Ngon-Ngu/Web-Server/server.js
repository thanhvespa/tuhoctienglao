#!/usr/bin/env node
/**
 * Zero-dependency secure Web Server & Auth/License Gate for the Course PWA.
 *
 * Features:
 * - Serves `dist-web/public/` publicly (app shell + configured free preview chapters).
 * - Protects full curriculum (`dist-web/protected/curriculum_data.json`) and paid audio files
 *   behind server-verified `scrypt` passwords, single-account bound HMAC-SHA256 license keys,
 *   and `HttpOnly` + `SameSite=Lax` signed session cookies with stateful device/session revocation.
 * - Supports HTTP `Range` (206 Partial Content) for smooth MP3/M4A playback on Safari & Chrome.
 * - Includes per-IP and per-account rate limiting, CSRF Origin/Sec-Fetch-Site verification, CSP &
 *   security headers, atomic `0o600` JSON persistence (with `.bak` copies and a cross-process lock
 *   shared with `tools/license_cli.py`), and optional `ADMIN_TOKEN` API.
 *
 * Environment:
 *   SESSION_SECRET  (>=32 chars, required in production) signs session cookies. Safe to rotate:
 *                   users are just logged out.
 *   LICENSE_SECRET  (>=32 chars, optional) hashes activation keys; defaults to `<DATA_DIR>/.license_secret`.
 *                   Must NEVER change once keys are issued. The CLI must see the same value.
 *   TRUST_PROXY     number of reverse proxies in front (0 = direct). COOKIE_SECURE=1 forces Secure cookies.
 *   DATA_DIR, DIST_DIR, ADMIN_TOKEN, HOST, PORT.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pipeline } = require("node:stream");
const botService = require("./bot");

const COOKIE_NAME = "course_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 15;
const ACCOUNT_MAX_FAILURES = 10;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

function sanitizeJson(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sanitizeJson);
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (!UNSAFE_KEYS.has(k)) out[k] = sanitizeJson(v);
  }
  return out;
}

function normalizeLicenseKey(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function getLicenseTier(lic) {
  if (!lic) return null;
  if (lic.tier === "pro" || lic.tier === "standard") return lic.tier;
  if (typeof lic.hint === "string" && (lic.hint.includes("-PRO-") || lic.hint.startsWith("PRO-") || lic.hint.includes("PRO"))) {
    return "pro";
  }
  return "standard";
}

function loadOrCreateServerSecret(dataDir) {
  const envSecret = process.env.SESSION_SECRET || "";
  if (envSecret) {
    if (envSecret.length < 32) {
      throw new Error("SESSION_SECRET phải có tối thiểu 32 ký tự.");
    }
    return envSecret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Bắt buộc khai báo biến môi trường SESSION_SECRET (>=32 ký tự) ở môi trường production.");
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secretPath = path.join(dataDir, ".server_secret");
  if (fs.existsSync(secretPath)) {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(secretPath, generated + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(secretPath, 0o600);
  } catch (_) {
    // Best-effort permission hardening
  }
  return generated;
}

function readSecretFile(secretPath) {
  try {
    const val = fs.readFileSync(secretPath, "utf8").trim();
    return val.length >= 32 ? val : "";
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

function licenseSecretFingerprint(secret) {
  return crypto
    .createHmac("sha256", secret)
    .update("license-secret-fingerprint")
    .digest("hex")
    .slice(0, 16);
}

/**
 * The license-hashing secret is separate from SESSION_SECRET so that rotating
 * the session secret never invalidates activation keys already issued.
 * Resolution order (identical in tools/license_cli.py): env LICENSE_SECRET,
 * then `<dataDir>/.license_secret`. A new secret is only generated when no
 * license has been issued yet; otherwise we refuse to start rather than
 * silently hash with a secret that matches nothing.
 */
function loadOrCreateLicenseSecret(dataDir, licensesFile) {
  const envSecret = process.env.LICENSE_SECRET || "";
  if (envSecret) {
    if (envSecret.length < 32) {
      throw new Error("LICENSE_SECRET phải có tối thiểu 32 ký tự.");
    }
    return envSecret;
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secretPath = path.join(dataDir, ".license_secret");
  const existing = readSecretFile(secretPath);
  if (existing) return existing;

  const issued = readDbStrict(licensesFile, "licenses").licenses.length;
  if (issued > 0) {
    throw new Error(
      `Đã có ${issued} mã kích hoạt nhưng không tìm thấy khóa băm mã (LICENSE_SECRET hoặc ${secretPath}). ` +
        "Hãy khôi phục đúng khóa đã dùng khi phát hành mã (bản cũ dùng chung giá trị SESSION_SECRET / .server_secret)."
    );
  }
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(secretPath, generated + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  return generated;
}

function hashLicenseKey(rawKey, secret) {
  const norm = normalizeLicenseKey(rawKey);
  return crypto.createHmac("sha256", secret).update("license:" + norm).digest("hex");
}

// Password hashing: async scrypt (never blocks the event loop) with the cost
// parameters stored inside the hash so they can be raised later.
// Format: scrypt$N$r$p$saltHex$hashHex   (legacy format: saltHex:hashHex, N=16384 r=8 p=1)
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 3 };
const SCRYPT_LEGACY_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 64;

function scryptAsync(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

function parsePasswordHash(stored) {
  const str = String(stored || "");
  const isHex = (s) => /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0;
  if (str.startsWith("scrypt$")) {
    const parts = str.split("$");
    if (parts.length !== 6) return null;
    const params = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
    const validN = Number.isInteger(params.N) && params.N >= 16384 && params.N <= 1048576 && (params.N & (params.N - 1)) === 0;
    const validRp = [params.r, params.p].every((x) => Number.isInteger(x) && x >= 1 && x <= 16);
    if (!validN || !validRp || !isHex(parts[4]) || !isHex(parts[5])) return null;
    return { params, saltHex: parts[4], hashHex: parts[5] };
  }
  const legacy = str.split(":");
  if (legacy.length !== 2 || !isHex(legacy[0]) || !isHex(legacy[1])) return null;
  return { params: SCRYPT_LEGACY_PARAMS, saltHex: legacy[0], hashHex: legacy[1] };
}

async function hashPassword(password) {
  const saltHex = crypto.randomBytes(16).toString("hex");
  const normalized = String(password || "").normalize("NFKC");
  const derived = await scryptAsync(normalized, Buffer.from(saltHex, "hex"), SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return ["scrypt", N, r, p, saltHex, derived.toString("hex")].join("$");
}

async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const normalized = String(password || "").normalize("NFKC");
  const actualBuf = await scryptAsync(normalized, Buffer.from(parsed.saltHex, "hex"), parsed.params);
  const expectedBuf = Buffer.from(parsed.hashHex, "hex");
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function passwordNeedsRehash(stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return true;
  const { N, r, p } = parsed.params;
  return N !== SCRYPT_PARAMS.N || r !== SCRYPT_PARAMS.r || p !== SCRYPT_PARAMS.p || !String(stored).startsWith("scrypt$");
}

function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update("sess:" + body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySessionToken(token, secret) {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!sig) return null;
  const expected = crypto.createHmac("sha256", secret).update("sess:" + body).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.uid !== "string" || typeof parsed.jti !== "string") return null;
    if (typeof parsed.exp !== "number" || Date.now() > parsed.exp) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && !UNSAFE_KEYS.has(k)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch (_) {
        out[k] = v;
      }
    }
  }
  return out;
}

function readJsonStore(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

/**
 * Strict reader for the auth stores (users.json / licenses.json).
 * Only a MISSING file yields an empty store. An unreadable, corrupt or
 * wrongly-shaped file throws, so a later write can never replace real
 * accounts or licenses with an empty list.
 */
function readDbStrict(filePath, key) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { [key]: [] };
    throw Object.assign(new Error(`Không đọc được kho dữ liệu ${filePath}: ${err.message}`), { status: 500 });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw Object.assign(
      new Error(`Kho dữ liệu ${filePath} bị hỏng (JSON lỗi: ${err.message}). Khôi phục từ ${filePath}.bak trước khi chạy tiếp.`),
      { status: 500 }
    );
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed[key])) {
    throw Object.assign(new Error(`Kho dữ liệu ${filePath} sai cấu trúc (thiếu mảng "${key}").`), { status: 500 });
  }
  return parsed;
}

function writeJsonAtomic(filePath, data, { backup = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (backup && fs.existsSync(filePath)) {
    const bakPath = `${filePath}.bak`;
    fs.copyFileSync(filePath, bakPath);
    fs.chmodSync(bakPath, 0o600);
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}

const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 5 * 1000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process lock shared with tools/license_cli.py (`<dataDir>/.store.lock`,
 * created with O_EXCL). `fn` must be synchronous: it does a full
 * read-modify-write of the stores, so neither another request in this process
 * nor the admin CLI can interleave and lose an update.
 */
function withFileLock(dataDir, fn) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, ".store.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (_) {
        continue; // Lock vanished between open and stat: retry immediately
      }
      if (Date.now() > deadline) {
        throw Object.assign(new Error("Kho dữ liệu đang bận, vui lòng thử lại sau giây lát."), { status: 503 });
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lockPath);
    } catch (_) {
      // Already removed
    }
  }
}

function extractFreeAllowlist(curriculum, courseCfg) {
  const webCfg = (courseCfg && courseCfg.web) || (curriculum && curriculum.meta && curriculum.meta.web) || {};
  const freeChapters = new Set(Array.isArray(webCfg.free_chapters) ? webCfg.free_chapters : [1]);
  const freeDictLimit = Number.isFinite(webCfg.free_dict_limit) ? Number(webCfg.free_dict_limit) : 15;
  const freeCardIds = new Set();
  const freeLessonIds = new Set();

  if (curriculum && Array.isArray(curriculum.chapters)) {
    for (const ch of curriculum.chapters) {
      if (!freeChapters.has(ch.number)) continue;
      for (const les of ch.lessons || []) {
        if (les.id) freeLessonIds.add(les.id);
        for (const v of les.vocab || []) if (v.audio_id) freeCardIds.add(v.audio_id);
        for (const s of les.sentences || []) if (s.audio_id) freeCardIds.add(s.audio_id);
        for (const d of (les.dialogue && les.dialogue.lines) || []) {
          if (d.audio_id) freeCardIds.add(d.audio_id);
        }
      }
      if (ch.exam) {
        for (const it of (ch.exam.part_a && ch.exam.part_a.items) || []) {
          if (it.audio_id) freeCardIds.add(it.audio_id);
        }
        for (const it of (ch.exam.part_b && ch.exam.part_b.items) || []) {
          if (it.audio_id) freeCardIds.add(it.audio_id);
        }
      }
    }
  }

  for (const d of ((curriculum && curriculum.pocket_dict) || []).slice(0, Math.max(0, freeDictLimit))) {
    if (d.audio_id) freeCardIds.add(d.audio_id);
  }
  return { freeCardIds, freeLessonIds };
}

function createCourseApp(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, ".."));
  const distDir = path.resolve(options.distDir || process.env.DIST_DIR || path.join(projectRoot, "dist-web"));
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, "data"));
  const publicDir = path.join(distDir, "public");
  const protectedDir = path.join(distDir, "protected");
  const usersFile = path.join(dataDir, "users.json");
  const licensesFile = path.join(dataDir, "licenses.json");
  const progressDir = path.join(dataDir, "progress");

  const secret = options.secret || loadOrCreateServerSecret(dataDir);
  const licenseSecret = options.licenseSecret || loadOrCreateLicenseSecret(dataDir, licensesFile);
  const licenseFp = licenseSecretFingerprint(licenseSecret);
  {
    const storedFp = readDbStrict(licensesFile, "licenses").secret_fp;
    if (storedFp && storedFp !== licenseFp) {
      throw new Error(
        "Khóa băm mã kích hoạt (LICENSE_SECRET / .license_secret) không khớp với khóa đã dùng để phát hành " +
          `các mã trong ${licensesFile}. Mọi mã sẽ không kích hoạt được — hãy khôi phục đúng khóa.`
      );
    }
  }
  const adminToken = options.adminToken ?? (process.env.ADMIN_TOKEN || "");

  // Number of reverse proxies in front of this server that append to
  // X-Forwarded-For (TRUST_PROXY=1 for one nginx/Caddy, 2 for CDN + nginx...).
  const rawTrust = options.trustProxy ?? process.env.TRUST_PROXY ?? 0;
  const trustedHops = rawTrust === true ? 1 : Math.max(0, Math.floor(Number(rawTrust) || 0));
  const trustProxy = trustedHops > 0;

  const courseCfgPath = path.join(projectRoot, "course.config.json");
  const courseCfg = fs.existsSync(courseCfgPath)
    ? JSON.parse(fs.readFileSync(courseCfgPath, "utf8"))
    : {};

  const fullCurriculumPath = path.join(protectedDir, "curriculum_data.json");
  const loadFullCurriculum = () => {
    if (!fs.existsSync(fullCurriculumPath)) return null;
    return JSON.parse(fs.readFileSync(fullCurriculumPath, "utf8"));
  };

  let cachedCurriculum = loadFullCurriculum();
  let allowlist = extractFreeAllowlist(cachedCurriculum, courseCfg);

  const refreshCurriculumCache = () => {
    cachedCurriculum = loadFullCurriculum();
    allowlist = extractFreeAllowlist(cachedCurriculum, courseCfg);
  };

  // All store mutations are synchronous read-modify-write sections under the
  // cross-process file lock (also taken by tools/license_cli.py).
  const mutateStore = (fn) => withFileLock(dataDir, fn);

  // Bounded sliding-window rate limiter. `rateStatus` only inspects a bucket,
  // `rateRecord` adds one event to it.
  const rateBuckets = new Map();
  const rateStatus = (key, max = RATE_MAX_ATTEMPTS) => {
    const now = Date.now();
    const list = (rateBuckets.get(key) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
    if (list.length) rateBuckets.set(key, list);
    else rateBuckets.delete(key);
    if (list.length >= max) {
      const retrySec = Math.ceil((RATE_WINDOW_MS - (now - list[0])) / 1000);
      return { allowed: false, retryAfter: Math.max(1, retrySec) };
    }
    return { allowed: true, retryAfter: 0 };
  };
  const rateRecord = (key) => {
    const now = Date.now();
    if (rateBuckets.size > 5000) {
      for (const [k, stamps] of rateBuckets.entries()) {
        if (!stamps.length || now - stamps[stamps.length - 1] > RATE_WINDOW_MS) {
          rateBuckets.delete(k);
        }
      }
    }
    const list = rateBuckets.get(key) || [];
    list.push(now);
    rateBuckets.set(key, list);
  };

  // Per-IP: every auth request counts.
  const checkRateLimit = (ip, bucketName) => {
    const key = `${bucketName}:${ip}`;
    const status = rateStatus(key);
    if (status.allowed) rateRecord(key);
    return status;
  };

  // Per-account: only FAILED password checks count, and a success clears them,
  // so guessing is capped even when the attacker rotates IP addresses.
  const accountKey = (email) => `acct:${email}`;
  const accountStatus = (email) => rateStatus(accountKey(email), ACCOUNT_MAX_FAILURES);
  const sendAccountLocked = (res, retryAfter) =>
    sendJson(
      res,
      429,
      { error: `Tài khoản này nhập sai mật khẩu quá nhiều lần. Vui lòng đợi ${retryAfter} giây.` },
      { "Retry-After": String(retryAfter) }
    );

  // Client-supplied X-Forwarded-For entries are forgeable; only the entries
  // appended by our own proxies (the last `trustedHops` ones) can be trusted.
  const getClientIp = (req) => {
    const direct = (req.socket && req.socket.remoteAddress) || "local";
    if (!trustProxy) return direct;
    const chain = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!chain.length) return direct;
    return chain[Math.max(0, chain.length - trustedHops)];
  };

  let dummyHashPromise = null;
  const getDummyHash = () => {
    if (!dummyHashPromise) dummyHashPromise = hashPassword(crypto.randomBytes(16).toString("hex"));
    return dummyHashPromise;
  };

  const findUsableLicense = (licensesDb, keyHash, courseId) => {
    const lic = licensesDb.licenses.find((l) => l.key_hash === keyHash);
    if (!lic || lic.revoked) {
      return { error: { status: 403, payload: { error: "Mã kích hoạt không tồn tại hoặc đã bị thu hồi." } } };
    }
    if (lic.course_id !== courseId && lic.course_id !== "*") {
      return { error: { status: 403, payload: { error: "Mã kích hoạt này dành cho khóa ngôn ngữ khác." } } };
    }
    return { lic };
  };

  const CONFLICT = { status: 409, payload: { error: "Tài khoản vừa thay đổi ở nơi khác. Vui lòng thử lại." } };

  const isSecureReq = (req) => {
    if (process.env.COOKIE_SECURE === "1") return true;
    if (req.socket && req.socket.encrypted) return true;
    return trustProxy && String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
  };

  const buildSessionCookieHeader = (req, value, maxAgeSec) => {
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(value)}`,
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
      `Max-Age=${maxAgeSec}`,
    ];
    if (isSecureReq(req)) parts.push("Secure");
    return parts.join("; ");
  };

  const applySecurityHeaders = (res, extra = {}) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "media-src 'self' blob:; img-src 'self' data:; font-src 'self'; " +
        "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
    );
    for (const [k, v] of Object.entries(extra)) {
      res.setHeader(k, v);
    }
  };

  const sendJson = (res, status, data, headers = {}) => {
    const body = JSON.stringify(data);
    applySecurityHeaders(res, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.writeHead(status);
    res.end(body);
  };

  const readJsonBody = (req, maxBytes = 65536) =>
    new Promise((resolve, reject) => {
      let total = 0;
      const chunks = [];
      let aborted = false;
      req.on("data", (chunk) => {
        if (aborted) return;
        total += chunk.length;
        if (total > maxBytes) {
          aborted = true;
          reject(Object.assign(new Error("Payload too large"), { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (aborted) return;
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          const parsed = text ? JSON.parse(text) : {};
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            reject(Object.assign(new Error("Dữ liệu JSON không hợp lệ."), { status: 400 }));
            return;
          }
          resolve(sanitizeJson(parsed));
        } catch (_) {
          reject(Object.assign(new Error("Không đọc được JSON request."), { status: 400 }));
        }
      });
      req.on("error", () => reject(Object.assign(new Error("Lỗi đọc request."), { status: 400 })));
    });

  const checkCsrfOrigin = (req) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host) {
      try {
        return new URL(origin).host === host;
      } catch (_) {
        return false;
      }
    }
    const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
    if (fetchSite === "cross-site") return false;
    return true;
  };

  const getCourseId = () => {
    if (cachedCurriculum && cachedCurriculum.meta && cachedCurriculum.meta.course_id) {
      return cachedCurriculum.meta.course_id;
    }
    return courseCfg.course_id || "tu-hoc-tieng-lao";
  };

  const getMaxDevices = () => {
    const webCfg = (courseCfg && courseCfg.web) || {};
    return Math.max(1, Number(webCfg.max_devices_per_user || 3));
  };

  const getAuthenticatedContext = (req) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    const sess = verifySessionToken(token, secret);
    if (!sess) return null;

    const usersDb = readDbStrict(usersFile, "users");
    const user = usersDb.users.find((u) => u.id === sess.uid);
    if (!user) return null;

    const now = Date.now();
    const activeSession = (user.sessions || []).find(
      (s) => s.jti === sess.jti && (!s.expires_at || s.expires_at > now)
    );
    if (!activeSession) return null;

    const courseId = getCourseId();
    const licensesDb = readDbStrict(licensesFile, "licenses");
    const activeLicenses = licensesDb.licenses.filter(
      (lic) =>
        !lic.revoked &&
        lic.bound_user_id === user.id &&
        (lic.course_id === courseId || lic.course_id === "*")
    );
    const hasActiveLicense = activeLicenses.length > 0;
    const isPro = activeLicenses.some((l) => getLicenseTier(l) === "pro") || user.tier === "pro";
    const tier = hasActiveLicense ? (isPro ? "pro" : "standard") : null;

    return {
      user,
      jti: sess.jti,
      unlocked: hasActiveLicense,
      tier,
      courseId,
    };
  };

  // `pipeline` closes the file descriptor when the client disconnects mid-stream
  // (very common while seeking audio) and turns read errors into a destroyed
  // response instead of an unhandled 'error' event that would crash the process.
  const streamFileTo = (req, res, absFile, range) => {
    if ((req.method || "GET").toUpperCase() === "HEAD") {
      res.end();
      return;
    }
    pipeline(fs.createReadStream(absFile, range), res, (err) => {
      if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        console.error(`[stream] ${absFile}: ${err.message}`);
      }
    });
  };

  const serveFileWithRange = (req, res, absFile, cacheControl) => {
    let stat;
    try {
      stat = fs.statSync(absFile);
      if (!stat.isFile()) return false;
    } catch (_) {
      return false;
    }

    const ext = path.extname(absFile).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const range = req.headers.range;

    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) {
        applySecurityHeaders(res, { "Content-Range": `bytes */${stat.size}` });
        res.writeHead(416);
        res.end();
        return true;
      }
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
      if (Number.isNaN(start) || start >= stat.size || end < start) {
        applySecurityHeaders(res, { "Content-Range": `bytes */${stat.size}` });
        res.writeHead(416);
        res.end();
        return true;
      }
      applySecurityHeaders(res, {
        "Content-Type": mime,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": cacheControl,
      });
      res.writeHead(206);
      streamFileTo(req, res, absFile, { start, end });
      return true;
    }

    applySecurityHeaders(res, {
      "Content-Type": mime,
      "Content-Length": String(stat.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheControl,
    });
    res.writeHead(200);
    streamFileTo(req, res, absFile);
    return true;
  };

  const resolveSafeUnder = (rootDir, relSegments) => {
    for (const seg of relSegments) {
      if (!seg || seg === "." || seg === ".." || seg.startsWith(".") || seg.includes("\0")) {
        return null;
      }
    }
    const candidate = path.resolve(rootDir, ...relSegments);
    if (candidate !== rootDir && !candidate.startsWith(rootDir + path.sep)) return null;
    try {
      const realRoot = fs.realpathSync(rootDir);
      const realCand = fs.realpathSync(candidate);
      if (realCand !== realRoot && !realCand.startsWith(realRoot + path.sep)) return null;
      return realCand;
    } catch (_) {
      return null;
    }
  };

  const resolveProtectedMedia = (subdir, filename) => {
    if (!/^[A-Za-z0-9_]+\.(mp3|m4a)$/i.test(filename)) return null;
    const primary = resolveSafeUnder(path.join(protectedDir, "Media-Audio", subdir), [filename]);
    if (primary) return primary;
    return resolveSafeUnder(path.join(projectRoot, "Media-Audio", subdir), [filename]);
  };

  const isAdminAuthorized = (req) => {
    if (!adminToken || adminToken.length < 16) return false;
    const auth = String(req.headers.authorization || "");
    if (!auth.startsWith("Bearer ")) return false;
    const provided = Buffer.from(auth.slice(7).trim(), "utf8");
    const expected = Buffer.from(adminToken, "utf8");
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  };

  const publicUserDto = (ctx) => ({
    email: ctx.user.email,
    display_name: ctx.user.display_name || ctx.user.email.split("@")[0],
    unlocked: ctx.unlocked,
    tier: ctx.tier || (ctx.unlocked ? (ctx.user && ctx.user.tier) || "standard" : null),
    active_devices: (ctx.user.sessions || []).filter((s) => !s.expires_at || s.expires_at > Date.now()).length,
    max_devices: getMaxDevices(),
  });

  const handleRequest = async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      let pathname;
      try {
        pathname = decodeURIComponent(parsedUrl.pathname);
      } catch (_) {
        return sendJson(res, 400, { error: "Đường dẫn URL không hợp lệ." });
      }
      if (pathname.includes("\0")) {
        return sendJson(res, 400, { error: "Yêu cầu không hợp lệ." });
      }

      const method = (req.method || "GET").toUpperCase();

      // Enforce CSRF Origin check on mutating API calls (unless bearer-auth admin route or bot webhooks)
      if (pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(method)) {
        if (!pathname.startsWith("/api/admin/") && !pathname.startsWith("/api/bot/") && !checkCsrfOrigin(req)) {
          return sendJson(res, 403, { error: "Yêu cầu bị từ chối bởi kiểm tra Origin (CSRF)." });
        }
      }

      const getBotStore = () => {
        try {
          return {
            licenses: readDbStrict(licensesFile, "licenses").licenses || [],
            users: readDbStrict(usersFile, "users").users || [],
          };
        } catch (_) {
          return { licenses: [], users: [] };
        }
      };

      // ---- BOT ROUTES (TELEGRAM & ZALO) ----
      if (pathname === "/api/bot/faq" && method === "GET") {
        return sendJson(res, 200, { ok: true, faqs: botService.FAQ_DATABASE });
      }

      if (pathname === "/api/bot/remind" && method === "GET") {
        return sendJson(res, 200, { ok: true, reminder: botService.getDailyReminder() });
      }

      if (pathname === "/api/bot/quiz" && method === "GET") {
        if (!cachedCurriculum) refreshCurriculumCache();
        return sendJson(res, 200, { ok: true, quiz: botService.generateMicroQuiz(cachedCurriculum) });
      }

      if (pathname === "/api/bot/check" && method === "POST") {
        const body = await readJsonBody(req);
        const query = String(body.query || body.license_key || body.email || "").trim();
        const store = getBotStore();
        return sendJson(res, 200, botService.checkLicenseInfo(query, store));
      }

      if (pathname === "/api/bot/telegram" && method === "POST") {
        const body = await readJsonBody(req);
        const store = getBotStore();
        if (!cachedCurriculum) refreshCurriculumCache();
        const result = botService.handleTelegramWebhook(body, store, cachedCurriculum);
        return sendJson(res, 200, result);
      }

      if (pathname === "/api/bot/zalo" && method === "POST") {
        const body = await readJsonBody(req);
        const store = getBotStore();
        if (!cachedCurriculum) refreshCurriculumCache();
        const result = botService.handleZaloWebhook(body, store, cachedCurriculum);
        return sendJson(res, 200, result);
      }

      // ---- AUTH & COURSE API ROUTES ----
      if (pathname === "/api/auth/me" && method === "GET") {
        const ctx = getAuthenticatedContext(req);
        if (!ctx) {
          return sendJson(res, 200, {
            authenticated: false,
            unlocked: false,
            tier: null,
            course_id: getCourseId(),
          });
        }
        return sendJson(res, 200, {
          authenticated: true,
          unlocked: ctx.unlocked,
          tier: ctx.tier,
          course_id: ctx.courseId,
          user: publicUserDto(ctx),
        });
      }

      if (pathname === "/api/auth/register" && method === "POST") {
        const rl = checkRateLimit(getClientIp(req), "auth");
        if (!rl.allowed) {
          return sendJson(
            res,
            429,
            { error: `Quá nhiều lần thử. Vui lòng đợi ${rl.retryAfter} giây.` },
            { "Retry-After": String(rl.retryAfter) }
          );
        }
        const body = await readJsonBody(req);
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        const rawKey = String(body.license_key || "");
        const displayName = String(body.display_name || "").trim().slice(0, 60);
        const consent = body.consent === true || body.consent === "true";

        if (!consent) {
          return sendJson(res, 400, {
            error: "Bạn cần đồng ý với Điều khoản dịch vụ và Chính sách bảo vệ dữ liệu cá nhân (theo Nghị định 13/2023/NĐ-CP) để kích hoạt tài khoản. (Nếu không thấy ô tích chọn, vui lòng nhấn Ctrl+F5 / Cmd+Shift+R hoặc xóa cache trình duyệt để cập nhật).",
          });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) {
          return sendJson(res, 400, { error: "Email không hợp lệ." });
        }
        if (password.length < 8 || password.length > 128) {
          return sendJson(res, 400, { error: "Mật khẩu phải từ 8 đến 128 ký tự." });
        }
        const normKey = normalizeLicenseKey(rawKey);
        if (normKey.length < 8) {
          return sendJson(res, 400, { error: "Mã kích hoạt không đúng định dạng." });
        }

        const acct = accountStatus(email);
        if (!acct.allowed) return sendAccountLocked(res, acct.retryAfter);

        const courseId = getCourseId();
        const keyHash = hashLicenseKey(rawKey, licenseSecret);

        // Phase 1 (no lock, async): validate the key, then do the slow scrypt work.
        const preCheck = findUsableLicense(readDbStrict(licensesFile, "licenses"), keyHash, courseId);
        if (preCheck.error) return sendJson(res, preCheck.error.status, preCheck.error.payload);

        const existing = readDbStrict(usersFile, "users").users.find((u) => u.email === email) || null;
        let freshHash = null;
        if (existing) {
          if (!(await verifyPassword(password, existing.password_hash))) {
            rateRecord(accountKey(email));
            return sendJson(res, 401, { error: "Email đã tồn tại và mật khẩu không đúng." });
          }
          if (passwordNeedsRehash(existing.password_hash)) freshHash = await hashPassword(password);
        } else {
          freshHash = await hashPassword(password);
        }

        // Phase 2 (locked, synchronous): re-read the stores and commit.
        const result = mutateStore(() => {
          const usersDb = readDbStrict(usersFile, "users");
          const licensesDb = readDbStrict(licensesFile, "licenses");

          const check = findUsableLicense(licensesDb, keyHash, courseId);
          if (check.error) return check.error;
          const lic = check.lic;

          let user = usersDb.users.find((u) => u.email === email) || null;
          const sameAccount = existing
            ? user && user.id === existing.id && user.password_hash === existing.password_hash
            : !user;
          if (!sameAccount) return CONFLICT;

          if (lic.bound_user_id && (!user || lic.bound_user_id !== user.id)) {
            return { status: 403, payload: { error: "Mã kích hoạt này đã được gắn cho tài khoản khác." } };
          }

          const licTier = getLicenseTier(lic);
          const now = Date.now();
          if (!user) {
            user = {
              id: "usr_" + crypto.randomBytes(8).toString("hex"),
              email,
              display_name: displayName || email.split("@")[0],
              password_hash: freshHash,
              created_at: new Date(now).toISOString(),
              consent_at: new Date(now).toISOString(),
              consent_version: "1.0",
              tier: licTier,
              sessions: [],
            };
            usersDb.users.push(user);
          } else {
            if (freshHash) user.password_hash = freshHash;
            if (!user.consent_at) {
              user.consent_at = new Date(now).toISOString();
              user.consent_version = "1.0";
            }
            if (licTier === "pro" || !user.tier) {
              user.tier = licTier;
            }
          }

          lic.bound_user_id = user.id;
          lic.bound_email_masked = email.replace(/(^..).*(@.*$)/, "$1***$2");
          if (!lic.activated_at) lic.activated_at = new Date(now).toISOString();

          const jti = crypto.randomBytes(12).toString("hex");
          const exp = now + SESSION_TTL_MS;
          const active = (user.sessions || []).filter((s) => !s.expires_at || s.expires_at > now);
          active.push({ jti, created_at: now, expires_at: exp });
          const maxDev = getMaxDevices();
          user.sessions = active.slice(-maxDev);

          licensesDb.secret_fp = licenseFp;
          writeJsonAtomic(usersFile, usersDb, { backup: true });
          writeJsonAtomic(licensesFile, licensesDb, { backup: true });

          const cookieToken = signSession({ uid: user.id, jti, iat: now, exp }, secret);
          const userTier = user.tier || licTier;
          return {
            status: 200,
            cookie: cookieToken,
            payload: {
              authenticated: true,
              unlocked: true,
              tier: userTier,
              course_id: courseId,
              user: publicUserDto({ user, unlocked: true, tier: userTier }),
            },
          };
        });
        if (result.status === 200) rateBuckets.delete(accountKey(email));

        const headers = result.cookie
          ? { "Set-Cookie": buildSessionCookieHeader(req, result.cookie, SESSION_TTL_MS / 1000) }
          : {};
        return sendJson(res, result.status, result.payload, headers);
      }

      if (pathname === "/api/auth/login" && method === "POST") {
        const rl = checkRateLimit(getClientIp(req), "auth");
        if (!rl.allowed) {
          return sendJson(
            res,
            429,
            { error: `Quá nhiều lần đăng nhập sai. Vui lòng đợi ${rl.retryAfter} giây.` },
            { "Retry-After": String(rl.retryAfter) }
          );
        }
        const body = await readJsonBody(req);
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        if (!email || !password || password.length > 128 || email.length > 120) {
          return sendJson(res, 400, { error: "Vui lòng nhập đầy đủ Email và mật khẩu." });
        }

        const acct = accountStatus(email);
        if (!acct.allowed) return sendAccountLocked(res, acct.retryAfter);

        // Phase 1 (no lock, async): scrypt. Unknown emails are checked against a
        // dummy hash so response time does not reveal whether the account exists.
        const snapshot = readDbStrict(usersFile, "users").users.find((u) => u.email === email) || null;
        const passwordOk = await verifyPassword(password, snapshot ? snapshot.password_hash : await getDummyHash());
        if (!snapshot || !passwordOk) {
          rateRecord(accountKey(email));
          return sendJson(res, 401, { error: "Email hoặc mật khẩu không đúng." });
        }
        const upgradedHash = passwordNeedsRehash(snapshot.password_hash) ? await hashPassword(password) : null;

        // Phase 2 (locked, synchronous): re-read the store and commit the session.
        const result = mutateStore(() => {
          const usersDb = readDbStrict(usersFile, "users");
          const user = usersDb.users.find((u) => u.id === snapshot.id);
          if (!user || user.password_hash !== snapshot.password_hash) return CONFLICT;
          if (upgradedHash) user.password_hash = upgradedHash;

          const now = Date.now();
          const jti = crypto.randomBytes(12).toString("hex");
          const exp = now + SESSION_TTL_MS;
          const active = (user.sessions || []).filter((s) => !s.expires_at || s.expires_at > now);
          active.push({ jti, created_at: now, expires_at: exp });
          user.sessions = active.slice(-getMaxDevices());
          writeJsonAtomic(usersFile, usersDb, { backup: true });

          const licensesDb = readDbStrict(licensesFile, "licenses");
          const courseId = getCourseId();
          const userLicenses = licensesDb.licenses.filter(
            (l) => !l.revoked && l.bound_user_id === user.id && (l.course_id === courseId || l.course_id === "*")
          );
          const unlocked = userLicenses.length > 0;
          const isPro = userLicenses.some((l) => getLicenseTier(l) === "pro") || user.tier === "pro";
          const userTier = unlocked ? (isPro ? "pro" : "standard") : null;
          if (unlocked && user.tier !== userTier) {
            user.tier = userTier;
            writeJsonAtomic(usersFile, usersDb, { backup: true });
          }

          const cookieToken = signSession({ uid: user.id, jti, iat: now, exp }, secret);
          return {
            status: 200,
            cookie: cookieToken,
            payload: {
              authenticated: true,
              unlocked,
              tier: userTier,
              course_id: courseId,
              user: publicUserDto({ user, unlocked, tier: userTier }),
            },
          };
        });
        if (result.status === 200) rateBuckets.delete(accountKey(email));

        const headers = result.cookie
          ? { "Set-Cookie": buildSessionCookieHeader(req, result.cookie, SESSION_TTL_MS / 1000) }
          : {};
        return sendJson(res, result.status, result.payload, headers);
      }

      if (pathname === "/api/auth/activate" && method === "POST") {
        const rl = checkRateLimit(getClientIp(req), "auth");
        if (!rl.allowed) {
          return sendJson(
            res,
            429,
            { error: `Thử quá nhiều lần. Vui lòng đợi ${rl.retryAfter} giây.` },
            { "Retry-After": String(rl.retryAfter) }
          );
        }
        const ctx = getAuthenticatedContext(req);
        if (!ctx) {
          return sendJson(res, 401, { error: "Bạn cần đăng nhập trước khi nhập mã kích hoạt." });
        }
        const body = await readJsonBody(req);
        const rawKey = String(body.license_key || "");
        if (normalizeLicenseKey(rawKey).length < 8) {
          return sendJson(res, 400, { error: "Mã kích hoạt không hợp lệ." });
        }

        const result = mutateStore(() => {
          const licensesDb = readDbStrict(licensesFile, "licenses");
          const check = findUsableLicense(licensesDb, hashLicenseKey(rawKey, licenseSecret), ctx.courseId);
          if (check.error) return check.error;
          const lic = check.lic;
          if (lic.bound_user_id && lic.bound_user_id !== ctx.user.id) {
            return { status: 403, payload: { error: "Mã kích hoạt này đã được tài khoản khác sử dụng." } };
          }
          const licTier = getLicenseTier(lic);
          lic.bound_user_id = ctx.user.id;
          lic.bound_email_masked = ctx.user.email.replace(/(^..).*(@.*$)/, "$1***$2");
          if (!lic.activated_at) lic.activated_at = new Date().toISOString();
          licensesDb.secret_fp = licenseFp;
          writeJsonAtomic(licensesFile, licensesDb, { backup: true });

          const usersDb = readDbStrict(usersFile, "users");
          const targetUser = usersDb.users.find((u) => u.id === ctx.user.id);
          let effectiveTier = licTier;
          if (targetUser) {
            if (licTier === "pro" || !targetUser.tier) {
              targetUser.tier = licTier;
              writeJsonAtomic(usersFile, usersDb, { backup: true });
            }
            effectiveTier = targetUser.tier || licTier;
          }

          return {
            status: 200,
            payload: {
              unlocked: true,
              tier: effectiveTier,
              user: publicUserDto({ ...ctx, unlocked: true, tier: effectiveTier }),
            },
          };
        });
        return sendJson(res, result.status, result.payload);
      }

      if (pathname === "/api/auth/logout" && method === "POST") {
        const ctx = getAuthenticatedContext(req);
        if (ctx) {
          mutateStore(() => {
            const usersDb = readDbStrict(usersFile, "users");
            const user = usersDb.users.find((u) => u.id === ctx.user.id);
            if (user) {
              user.sessions = (user.sessions || []).filter((s) => s.jti !== ctx.jti);
              writeJsonAtomic(usersFile, usersDb, { backup: true });
            }
          });
        }
        return sendJson(res, 200, { ok: true }, { "Set-Cookie": buildSessionCookieHeader(req, "", 0) });
      }

      if (pathname === "/api/auth/logout-all" && method === "POST") {
        const ctx = getAuthenticatedContext(req);
        if (!ctx) return sendJson(res, 401, { error: "Chưa đăng nhập." });
        mutateStore(() => {
          const usersDb = readDbStrict(usersFile, "users");
          const user = usersDb.users.find((u) => u.id === ctx.user.id);
          if (user) {
            user.sessions = [];
            writeJsonAtomic(usersFile, usersDb, { backup: true });
          }
        });
        return sendJson(res, 200, { ok: true }, { "Set-Cookie": buildSessionCookieHeader(req, "", 0) });
      }

      if (pathname === "/api/curriculum" && method === "GET") {
        const ctx = getAuthenticatedContext(req);
        if (!ctx || !ctx.unlocked) {
          return sendJson(res, 401, { error: "Cần kích hoạt khóa học để tải toàn bộ giáo trình." });
        }
        if (!cachedCurriculum) refreshCurriculumCache();
        if (!cachedCurriculum) {
          return sendJson(res, 500, { error: "Chưa build dữ liệu protected/curriculum_data.json." });
        }
        return sendJson(res, 200, cachedCurriculum, { "Cache-Control": "private, no-store" });
      }

      if (pathname === "/api/progress") {
        const ctx = getAuthenticatedContext(req);
        if (!ctx) return sendJson(res, 401, { error: "Cần đăng nhập để đồng bộ tiến trình." });
        const userProgPath = path.join(progressDir, `${ctx.user.id}.json`);
        if (method === "GET") {
          return sendJson(res, 200, {
            progress: readJsonStore(userProgPath, null),
          });
        }
        if (method === "PUT") {
          const body = await readJsonBody(req, 262144);
          const clean = {
            completedUnits: sanitizeJson(body.completedUnits || {}),
            learnedCards: sanitizeJson(body.learnedCards || {}),
            examScores: sanitizeJson(body.examScores || {}),
            quizScores: sanitizeJson(body.quizScores || {}),
            examDrafts: sanitizeJson(body.examDrafts || {}),
            updated_at: new Date().toISOString(),
          };
          writeJsonAtomic(userProgPath, clean); // single atomic rename, no read-modify-write
          return sendJson(res, 200, { ok: true, updated_at: clean.updated_at });
        }
      }

      if (pathname === "/api/admin/licenses/generate" && method === "POST") {
        if (!isAdminAuthorized(req)) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }
        const body = await readJsonBody(req);
        const count = Math.min(200, Math.max(1, Number(body.count || 1)));

        // Support tier: "standard" | "pro"
        const reqTier = String(body.tier || "").toLowerCase();
        const reqPrefix = String(body.prefix || "").toUpperCase();
        const isPro = reqTier === "pro" || reqPrefix.includes("PRO");
        const tier = isPro ? "pro" : "standard";
        const tierTag = isPro ? "PRO" : "STD";

        let baseLang =
          (courseCfg.target_lang && courseCfg.target_lang.code ? String(courseCfg.target_lang.code) : "LAO")
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "") || "LAO";
        if (baseLang === "LO") baseLang = "LAO";
        const defaultPrefix = `${baseLang}-${tierTag}`;
        const prefix = reqPrefix ? reqPrefix.replace(/[^A-Z0-9-]/g, "") : defaultPrefix;
        const courseId = String(body.course_id || getCourseId());
        const note = String(body.note || "").slice(0, 120);
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

        const created = mutateStore(() => {
          const db = readDbStrict(licensesFile, "licenses");
          db.secret_fp = licenseFp;
          const rawKeys = [];
          for (let i = 0; i < count; i++) {
            const bytes = crypto.randomBytes(8);
            let seg = "";
            for (let j = 0; j < 8; j++) seg += alphabet[bytes[j] % alphabet.length];
            const rawKey = `${prefix}-${seg.slice(0, 4)}-${seg.slice(4, 8)}`;
            db.licenses.push({
              id: "lic_" + crypto.randomBytes(6).toString("hex"),
              key_hash: hashLicenseKey(rawKey, licenseSecret),
              hint: `${prefix}-****-${seg.slice(4, 8)}`,
              tier,
              course_id: courseId,
              note,
              revoked: false,
              bound_user_id: null,
              created_at: new Date().toISOString(),
            });
            rawKeys.push(rawKey);
          }
          writeJsonAtomic(licensesFile, db, { backup: true });
          return rawKeys;
        });
        return sendJson(res, 200, { count: created.length, tier, keys: created });
      }

      // ---- PROTECTED AUDIO GATEWAY ----
      if (pathname.startsWith("/Media-Audio/") && (method === "GET" || method === "HEAD")) {
        const parts = pathname.slice("/Media-Audio/".length).split("/");
        if (parts.length !== 2) {
          return sendJson(res, 404, { error: "Audio không tồn tại." });
        }
        const [subdir, filename] = parts;
        if (!["cards", "lessons"].includes(subdir)) {
          return sendJson(res, 403, { error: "Không có quyền truy cập thư mục này." });
        }

        const absFile = resolveProtectedMedia(subdir, filename);
        if (!absFile) {
          return sendJson(res, 404, { error: "Không tìm thấy file audio." });
        }

        const baseId = filename.replace(/\.(mp3|m4a)$/i, "");
        const isFreeAudio =
          subdir === "cards"
            ? allowlist.freeCardIds.has(baseId)
            : allowlist.freeLessonIds.has(baseId.replace(/_pimsleur$/, ""));

        if (!isFreeAudio) {
          const ctx = getAuthenticatedContext(req);
          if (!ctx || !ctx.unlocked) {
            return sendJson(res, 401, { error: "Audio thuộc nội dung đã khóa. Vui lòng kích hoạt khóa học." });
          }
        }

        const cacheHeader = isFreeAudio ? "public, max-age=86400" : "private, no-store";
        if (!serveFileWithRange(req, res, absFile, cacheHeader)) {
          return sendJson(res, 404, { error: "Không tìm thấy file audio." });
        }
        return;
      }

      // ---- PUBLIC STATIC SHELL (`dist-web/public/`) ----
      if (method === "GET" || method === "HEAD") {
        let rel = pathname;
        if (rel === "/") rel = "/index.html";
        else if (rel.endsWith("/")) rel += "index.html";

        const segments = rel.replace(/^\/+/, "").split("/");
        const absPublic = resolveSafeUnder(publicDir, segments);
        if (!absPublic) {
          return sendJson(res, 404, { error: "Không tìm thấy tài nguyên." });
        }
        const cacheHeader =
          absPublic.endsWith("sw.js") || absPublic.endsWith(".html")
            ? "no-cache"
            : "public, max-age=3600";
        if (!serveFileWithRange(req, res, absPublic, cacheHeader)) {
          return sendJson(res, 404, { error: "Không tìm thấy file." });
        }
        return;
      }

      sendJson(res, 405, { error: "Method Not Allowed" });
    } catch (err) {
      const status = err && err.status ? Number(err.status) : 500;
      if (status >= 500) {
        console.error(`[error] ${req.method} ${req.url}: ${(err && err.stack) || err}`);
      }
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      const msg = status === 503 || status < 500 ? err.message : "Lỗi máy chủ nội bộ.";
      try {
        sendJson(res, status, { error: msg });
      } catch (_) {
        res.destroy();
      }
    }
  };

  return {
    handleRequest,
    refreshCurriculumCache,
    paths: { projectRoot, distDir, dataDir, publicDir, protectedDir, usersFile, licensesFile },
  };
}

if (require.main === module) {
  const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  const port = Number(process.env.PORT || 8787);
  const app = createCourseApp();
  if (process.env.NODE_ENV === "production" && !Number(process.env.TRUST_PROXY || 0)) {
    console.warn(
      "[warn] TRUST_PROXY chưa đặt. Nếu server chạy sau reverse proxy (nginx/Caddy/CDN), mọi người dùng sẽ chung " +
        "một IP và chung một hạn mức đăng nhập — hãy đặt TRUST_PROXY=<số proxy phía trước> và COOKIE_SECURE=1."
    );
  }
  const server = http.createServer(app.handleRequest);
  server.listen(port, host, () => {
    console.log(`Course Web Server running at http://${host}:${port}/Slide-Tuong-Tac/`);
    console.log(`Public dir:    ${app.paths.publicDir}`);
    console.log(`Protected dir: ${app.paths.protectedDir}`);
    console.log(`Auth data dir: ${app.paths.dataDir}`);
  });
}

module.exports = {
  createCourseApp,
  hashLicenseKey,
  licenseSecretFingerprint,
  passwordNeedsRehash,
  normalizeLicenseKey,
  getLicenseTier,
  hashPassword,
  verifyPassword,
  signSession,
  verifySessionToken,
};
