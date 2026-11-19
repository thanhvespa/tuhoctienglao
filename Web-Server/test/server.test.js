"use strict";
/**
 * Security regression tests for Web-Server/server.js and tools/license_cli.py.
 *
 * Run from the project root:   node --test Web-Server/test/
 *
 * Every test runs against a throw-away data dir and a tiny fixture `dist-web`
 * created under the OS temp dir; nothing in the real project is read or
 * written except `course.config.json` (read-only, for the course id).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// crm.js / mailer.js / cron-scheduler.js resolve DATA_DIR when first required:
// point them at a throwaway directory so tests never touch Web-Server/data.
const MODULE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "course-test-modules-"));
process.env.DATA_DIR = MODULE_DATA_DIR;

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const srv = require(path.join(PROJECT_ROOT, "Web-Server", "server.js"));
const CLI = path.join(PROJECT_ROOT, "tools", "license_cli.py");

const SESSION_SECRET = "s".repeat(40);
const ADMIN_TOKEN = "admin-token-for-tests-0123456789";
const TG_SECRET = "telegram-webhook-secret-0123456789";
const ZALO_SECRET = "zalo-oa-secret-key-0123456789abcd";
const ZALO_APP_ID = "1234567890";

function zaloSigned(event) {
  const body = { app_id: ZALO_APP_ID, timestamp: String(Date.now()), ...event };
  const raw = JSON.stringify(body);
  const mac = crypto.createHash("sha256").update(ZALO_APP_ID + raw + body.timestamp + ZALO_SECRET).digest("hex");
  return { body, headers: { "x-zevent-signature": `mac=${mac}` } };
}
const PASSWORD = "correct-horse-1";
const FREE_LESSON = "c01_b01";
const PAID_CARD = "c02_b01_v01";

const tmpDirs = [];
function makeTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `course-test-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(MODULE_DATA_DIR, { recursive: true, force: true });
});

function makeFixtureDist() {
  const dist = makeTmp("dist");
  const pub = path.join(dist, "public");
  const cards = path.join(dist, "protected", "Media-Audio", "cards");
  const lessons = path.join(dist, "protected", "Media-Audio", "lessons");
  for (const d of [pub, cards, lessons]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(pub, "index.html"), "<!doctype html><title>fixture</title>");
  const lesson = (id, audioId) => ({
    id,
    vocab: [{ audio_id: audioId }],
    sentences: [],
    dialogue: { lines: [] },
  });
  const curriculum = {
    meta: {},
    chapters: [
      { number: 1, lessons: [lesson(FREE_LESSON, "c01_b01_v01")] },
      { number: 2, lessons: [lesson("c02_b01", PAID_CARD)] },
    ],
    pocket_dict: [],
  };
  fs.writeFileSync(path.join(dist, "protected", "curriculum_data.json"), JSON.stringify(curriculum));
  fs.writeFileSync(path.join(lessons, `${FREE_LESSON}_pimsleur.m4a`), crypto.randomBytes(256 * 1024));
  fs.writeFileSync(path.join(cards, `${PAID_CARD}.mp3`), crypto.randomBytes(2048));
  return dist;
}

/** Start a fresh app (own data dir, own rate-limit state) on a random port. */
async function startApp(t, overrides = {}) {
  const dataDir = overrides.dataDir || makeTmp("data");
  const app = srv.createCourseApp({
    projectRoot: PROJECT_ROOT,
    distDir: overrides.distDir || makeFixtureDist(),
    dataDir,
    secret: SESSION_SECRET,
    adminToken: overrides.adminToken ?? ADMIN_TOKEN,
    telegramWebhookSecret: overrides.telegramWebhookSecret ?? TG_SECRET,
    zaloOaSecret: overrides.zaloOaSecret ?? ZALO_SECRET,
    zaloAppId: ZALO_APP_ID,
    trustProxy: overrides.trustProxy ?? 1,
  });
  const server = http.createServer(app.handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections(); // do not wait for idle keep-alive sockets
      })
  );
  const port = server.address().port;

  const call = (method, urlPath, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: urlPath,
          method,
          headers: {
            ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            let json = null;
            try {
              json = JSON.parse(buf.toString("utf8"));
            } catch (_) {
              // Not JSON (audio / html)
            }
            resolve({ status: res.statusCode, json, headers: res.headers, length: buf.length });
          });
        }
      );
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });

  const issueKeys = async (count = 1, tier = "standard") => {
    const res = await call("POST", "/api/admin/licenses/generate", { count, tier }, { authorization: `Bearer ${ADMIN_TOKEN}` });
    assert.equal(res.status, 200);
    return res.json.keys;
  };

  const register = async (email, key, ip = "198.51.100.1", consent = true) => {
    const payload = { email, password: PASSWORD, license_key: key };
    if (consent) payload.consent = true;
    const res = await call("POST", "/api/auth/register", payload, { "x-forwarded-for": ip });
    const cookie = ((res.headers["set-cookie"] || [""])[0] || "").split(";")[0];
    return { res, cookie };
  };

  return { app, port, dataDir, call, issueKeys, register };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/* ------------------------------------------------------------------ */
/* Password hashing                                                    */
/* ------------------------------------------------------------------ */

test("password hash stores its scrypt parameters and verifies", async () => {
  const hash = await srv.hashPassword(PASSWORD);
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await srv.verifyPassword(PASSWORD, hash), true);
  assert.equal(await srv.verifyPassword("wrong-password", hash), false);
  assert.equal(srv.passwordNeedsRehash(hash), false);
});

test("legacy salt:hash passwords still verify and are flagged for rehash", async () => {
  const salt = crypto.randomBytes(16).toString("hex");
  const legacy = `${salt}:${crypto.scryptSync(PASSWORD, Buffer.from(salt, "hex"), 64).toString("hex")}`;
  assert.equal(await srv.verifyPassword(PASSWORD, legacy), true);
  assert.equal(await srv.verifyPassword("wrong-password", legacy), false);
  assert.equal(srv.passwordNeedsRehash(legacy), true);
});

test("malformed stored hashes are rejected, not crashed on", async () => {
  for (const bad of ["", "nonsense", "scrypt$1$8$1$00$00", "scrypt$99999999$8$1$aa$bb", "zz:yy", null]) {
    assert.equal(await srv.verifyPassword(PASSWORD, bad), false);
  }
});

/* ------------------------------------------------------------------ */
/* Auth flow                                                           */
/* ------------------------------------------------------------------ */

test("register, unlock curriculum, login, logout", async (t) => {
  const ctx = await startApp(t);
  const [key] = await ctx.issueKeys();
  const { res, cookie } = await ctx.register("flow@example.test", key);
  assert.equal(res.status, 200);
  assert.equal(res.json.unlocked, true);
  assert.equal(res.json.tier, "standard");
  assert.match(res.headers["set-cookie"][0], /HttpOnly/);
  assert.match(res.headers["set-cookie"][0], /SameSite=Lax/);

  assert.equal((await ctx.call("GET", "/api/curriculum")).status, 401);
  const full = await ctx.call("GET", "/api/curriculum", null, { cookie });
  assert.equal(full.status, 200);
  assert.equal(full.json.chapters.length, 2);

  const me = await ctx.call("GET", "/api/auth/me", null, { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.tier, "standard");
  assert.equal(me.json.user.tier, "standard");

  const login = await ctx.call("POST", "/api/auth/login", { email: "flow@example.test", password: PASSWORD });
  assert.equal(login.status, 200);
  assert.equal(login.json.unlocked, true);
  assert.equal(login.json.tier, "standard");

  assert.equal((await ctx.call("POST", "/api/auth/logout", null, { cookie })).status, 200);
  assert.equal((await ctx.call("GET", "/api/curriculum", null, { cookie })).status, 401);
});

test("register requires consent under Decree 13/2023/ND-CP", async (t) => {
  const ctx = await startApp(t);
  const [key] = await ctx.issueKeys();
  const res = await ctx.call(
    "POST",
    "/api/auth/register",
    { email: "no-consent@example.test", password: PASSWORD, license_key: key, consent: false },
    { "x-forwarded-for": "198.51.100.1" }
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Nghị định 13\/2023\/NĐ-CP/);
});

test("pro license activates pro tier and reports in /api/auth/me", async (t) => {
  const ctx = await startApp(t);
  const genRes = await ctx.call(
    "POST",
    "/api/admin/licenses/generate",
    { count: 1, tier: "pro" },
    { authorization: `Bearer ${ADMIN_TOKEN}` }
  );
  assert.equal(genRes.status, 200);
  assert.equal(genRes.json.tier, "pro");
  const proKey = genRes.json.keys[0];
  assert.match(proKey, /^LAO-PRO-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const { res, cookie } = await ctx.register("vip@example.test", proKey);
  assert.equal(res.status, 200);
  assert.equal(res.json.tier, "pro");
  assert.equal(res.json.user.tier, "pro");

  const me = await ctx.call("GET", "/api/auth/me", null, { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.tier, "pro");
  assert.equal(me.json.user.tier, "pro");
});

test("user can upgrade from standard to pro via /api/auth/activate", async (t) => {
  const ctx = await startApp(t);
  const [stdKey] = await ctx.issueKeys(1);
  assert.match(stdKey, /^LAO-STD-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const { res, cookie } = await ctx.register("upgrade@example.test", stdKey);
  assert.equal(res.status, 200);
  assert.equal(res.json.tier, "standard");

  const genPro = await ctx.call(
    "POST",
    "/api/admin/licenses/generate",
    { count: 1, tier: "pro" },
    { authorization: `Bearer ${ADMIN_TOKEN}` }
  );
  const proKey = genPro.json.keys[0];

  const actRes = await ctx.call(
    "POST",
    "/api/auth/activate",
    { license_key: proKey },
    { cookie }
  );
  assert.equal(actRes.status, 200);
  assert.equal(actRes.json.tier, "pro");
  assert.equal(actRes.json.user.tier, "pro");

  const me = await ctx.call("GET", "/api/auth/me", null, { cookie });
  assert.equal(me.json.tier, "pro");
  assert.equal(me.json.user.tier, "pro");
});

test("a license key cannot be bound to a second account", async (t) => {
  const ctx = await startApp(t);
  const [key] = await ctx.issueKeys();
  assert.equal((await ctx.register("first@example.test", key)).res.status, 200);
  const second = await ctx.register("second@example.test", key);
  assert.equal(second.res.status, 403);
  assert.equal(readJson(ctx.app.paths.usersFile).users.length, 1);
});

test("legacy password hash is upgraded on the next successful login", async (t) => {
  const ctx = await startApp(t);
  const [key] = await ctx.issueKeys();
  await ctx.register("legacy@example.test", key);

  const usersFile = ctx.app.paths.usersFile;
  const db = readJson(usersFile);
  const salt = crypto.randomBytes(16).toString("hex");
  db.users[0].password_hash = `${salt}:${crypto.scryptSync(PASSWORD, Buffer.from(salt, "hex"), 64).toString("hex")}`;
  fs.writeFileSync(usersFile, JSON.stringify(db));

  const login = await ctx.call("POST", "/api/auth/login", { email: "legacy@example.test", password: PASSWORD });
  assert.equal(login.status, 200);
  assert.match(readJson(usersFile).users[0].password_hash, /^scrypt\$/);
});

test("paid audio needs an activated session; free audio does not", async (t) => {
  const ctx = await startApp(t);
  const paid = `/Media-Audio/cards/${PAID_CARD}.mp3`;
  assert.equal((await ctx.call("GET", `/Media-Audio/lessons/${FREE_LESSON}_pimsleur.m4a`)).status, 200);
  assert.equal((await ctx.call("GET", paid)).status, 401);
  const [key] = await ctx.issueKeys();
  const { cookie } = await ctx.register("audio@example.test", key);
  assert.equal((await ctx.call("GET", paid, null, { cookie })).status, 200);
});

test("static path traversal and dotfiles are refused", async (t) => {
  const ctx = await startApp(t);
  for (const p of ["/..%2f..%2fprotected/curriculum_data.json", "/%2e%2e/protected/curriculum_data.json", "/.env"]) {
    assert.equal((await ctx.call("GET", p)).status, 404, p);
  }
  assert.equal((await ctx.call("GET", "/Media-Audio/cards/..%2f..%2fcurriculum_data.json")).status, 404);
});

test("cross-origin POST is rejected by the CSRF check", async (t) => {
  const ctx = await startApp(t);
  const res = await ctx.call("POST", "/api/auth/login", { email: "a@example.test", password: PASSWORD }, { origin: "https://evil.example" });
  assert.equal(res.status, 403);
});

/* ------------------------------------------------------------------ */
/* Fix 1: rate limiting                                                */
/* ------------------------------------------------------------------ */

test("account locks after 10 wrong passwords even when every request has a new IP", async (t) => {
  const ctx = await startApp(t);
  const [key] = await ctx.issueKeys();
  await ctx.register("lock@example.test", key);

  const codes = [];
  for (let i = 0; i < 12; i++) {
    const res = await ctx.call("POST", "/api/auth/login", { email: "lock@example.test", password: `wrong-${i}` }, { "x-forwarded-for": `203.0.113.${i}` });
    codes.push(res.status);
  }
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
  assert.deepEqual(codes.slice(10), [429, 429]);

  const correct = await ctx.call("POST", "/api/auth/login", { email: "lock@example.test", password: PASSWORD }, { "x-forwarded-for": "203.0.113.200" });
  assert.equal(correct.status, 429);
  assert.ok(Number(correct.headers["retry-after"]) > 0);
});

test("a successful login clears the account failure counter", async (t) => {
  const ctx = await startApp(t);
  const [key] = await ctx.issueKeys();
  await ctx.register("reset@example.test", key);
  const attempt = (password, i) =>
    ctx.call("POST", "/api/auth/login", { email: "reset@example.test", password }, { "x-forwarded-for": `203.0.113.${i}` });

  for (let i = 0; i < 9; i++) assert.equal((await attempt("wrong", i)).status, 401);
  assert.equal((await attempt(PASSWORD, 50)).status, 200);
  for (let i = 0; i < 9; i++) assert.equal((await attempt("wrong", 60 + i)).status, 401);
  assert.equal((await attempt(PASSWORD, 99)).status, 200);
});

test("a forged leftmost X-Forwarded-For entry cannot dodge the per-IP limit", async (t) => {
  const ctx = await startApp(t, { trustProxy: 1 });
  const codes = [];
  for (let i = 0; i < 17; i++) {
    // The client forges the first entry; the trusted proxy appends the real one last.
    const res = await ctx.call("POST", "/api/auth/login", { email: `nobody${i}@example.test`, password: PASSWORD }, { "x-forwarded-for": `192.0.2.${i}, 198.51.100.77` });
    codes.push(res.status);
  }
  assert.deepEqual(codes.slice(0, 15), Array(15).fill(401));
  assert.deepEqual(codes.slice(15), [429, 429]);
});

test("X-Forwarded-For is ignored entirely when no proxy is trusted", async (t) => {
  const ctx = await startApp(t, { trustProxy: 0 });
  let last;
  for (let i = 0; i < 16; i++) {
    last = await ctx.call("POST", "/api/auth/login", { email: `nobody${i}@example.test`, password: PASSWORD }, { "x-forwarded-for": `192.0.2.${i}` });
  }
  assert.equal(last.status, 429);
});

/* ------------------------------------------------------------------ */
/* Fix 2: separate license secret                                      */
/* ------------------------------------------------------------------ */

test("license secret is independent from the session secret", async (t) => {
  const ctx = await startApp(t);
  const [key] = await ctx.issueKeys();
  const licenseSecret = fs.readFileSync(path.join(ctx.dataDir, ".license_secret"), "utf8").trim();
  assert.ok(licenseSecret.length >= 32);
  assert.notEqual(licenseSecret, SESSION_SECRET);

  const db = readJson(ctx.app.paths.licensesFile);
  assert.equal(db.licenses[0].key_hash, srv.hashLicenseKey(key, licenseSecret));
  assert.equal(db.secret_fp, srv.licenseSecretFingerprint(licenseSecret));

  // Rotating the session secret must keep issued keys valid.
  const rotated = srv.createCourseApp({ projectRoot: PROJECT_ROOT, distDir: makeFixtureDist(), dataDir: ctx.dataDir, secret: "r".repeat(40) });
  assert.ok(rotated);
});

test("server refuses to start with a license secret that does not match issued keys", async (t) => {
  const ctx = await startApp(t);
  await ctx.issueKeys();
  const opts = { projectRoot: PROJECT_ROOT, distDir: makeFixtureDist(), dataDir: ctx.dataDir, secret: SESSION_SECRET };
  assert.throws(() => srv.createCourseApp({ ...opts, licenseSecret: "x".repeat(40) }), /không khớp/);

  // Secret file lost while licenses exist: refuse rather than generate a new one.
  fs.rmSync(path.join(ctx.dataDir, ".license_secret"));
  assert.throws(() => srv.createCourseApp(opts), /không tìm thấy khóa băm mã/);
});

/* ------------------------------------------------------------------ */
/* Fix 3: store integrity                                              */
/* ------------------------------------------------------------------ */

test("a corrupt users.json fails closed and is never overwritten", async (t) => {
  const ctx = await startApp(t);
  const [k1, k2] = await ctx.issueKeys(2);
  const { cookie } = await ctx.register("keep@example.test", k1);
  const usersFile = ctx.app.paths.usersFile;
  assert.ok(fs.existsSync(`${ctx.app.paths.licensesFile}.bak`), "backup copy is kept on write");

  t.mock.method(console, "error", () => {});
  fs.writeFileSync(usersFile, "{ this is not json");
  assert.equal((await ctx.register("new@example.test", k2)).res.status, 500);
  assert.equal((await ctx.call("POST", "/api/auth/login", { email: "keep@example.test", password: PASSWORD })).status, 500);
  assert.equal((await ctx.call("GET", "/api/curriculum", null, { cookie })).status, 500);
  assert.equal(fs.readFileSync(usersFile, "utf8"), "{ this is not json");

  fs.writeFileSync(usersFile, JSON.stringify({ wrong: "shape" }));
  assert.equal((await ctx.register("new@example.test", k2)).res.status, 500);
  assert.deepEqual(readJson(usersFile), { wrong: "shape" });
});

test("a held store lock yields 503; a stale lock is reclaimed", async (t) => {
  const ctx = await startApp(t);
  const [key] = await ctx.issueKeys();
  const { cookie } = await ctx.register("locked@example.test", key);
  const lock = path.join(ctx.dataDir, ".store.lock");

  t.mock.method(console, "error", () => {});
  fs.writeFileSync(lock, "");
  assert.equal((await ctx.call("POST", "/api/auth/logout-all", null, { cookie })).status, 503);
  assert.ok(fs.existsSync(lock), "a live lock held by another process is left alone");

  const old = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(lock, old, old);
  assert.equal((await ctx.call("POST", "/api/auth/logout-all", null, { cookie })).status, 200);
  assert.equal(fs.existsSync(lock), false);
});

/* ------------------------------------------------------------------ */
/* Fix 4: streaming                                                    */
/* ------------------------------------------------------------------ */

test("range requests work and aborted streams leak no file descriptors", async (t) => {
  const ctx = await startApp(t);
  const audio = `/Media-Audio/lessons/${FREE_LESSON}_pimsleur.m4a`;
  const fdCount = () => fs.readdirSync("/dev/fd").length;
  const canCountFds = fs.existsSync("/dev/fd");
  const before = canCountFds ? fdCount() : 0;

  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: ctx.port, path: audio, headers: { range: "bytes=0-" } }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
        res.on("error", () => {});
      });
      req.on("error", () => resolve());
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  const part = await ctx.call("GET", audio, null, { range: "bytes=10-109" });
  assert.equal(part.status, 206);
  assert.equal(part.length, 100);
  assert.match(part.headers["content-range"], /^bytes 10-109\/\d+$/);
  assert.equal((await ctx.call("GET", audio, null, { range: "bytes=99999999-" })).status, 416);

  const head = await ctx.call("HEAD", audio);
  assert.equal(head.status, 200);
  assert.equal(head.length, 0);

  if (canCountFds) assert.ok(fdCount() - before <= 3, `fd count grew from ${before} to ${fdCount()}`);
});

/* ------------------------------------------------------------------ */
/* CLI interop (tools/license_cli.py)                                  */
/* ------------------------------------------------------------------ */

const hasPython = spawnSync("python3", ["--version"]).status === 0;

function runCli(dataDir, args, extraEnv = {}) {
  const env = { ...process.env, DATA_DIR: dataDir, ...extraEnv };
  if (!("LICENSE_SECRET" in extraEnv)) delete env.LICENSE_SECRET;
  delete env.SESSION_SECRET;
  return spawnSync("python3", [CLI, ...args], { env, encoding: "utf8" });
}

test("keys issued by the CLI activate on the server; revoke locks them again", { skip: !hasPython && "python3 not available" }, async (t) => {
  const dataDir = makeTmp("data");
  const batch = path.join(dataDir, "batch.txt");
  const gen = runCli(dataDir, ["generate", "--count", "2", "--save-batch", batch]);
  assert.equal(gen.status, 0, gen.stderr);
  const keys = fs.readFileSync(batch, "utf8").trim().split("\n");
  assert.equal(fs.statSync(path.join(dataDir, ".license_secret")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dataDir, "licenses.json")).mode & 0o777, 0o600);

  const ctx = await startApp(t, { dataDir });
  const { res, cookie } = await ctx.register("cli@example.test", keys[0]);
  assert.equal(res.status, 200);
  assert.equal((await ctx.call("GET", "/api/curriculum", null, { cookie })).status, 200);

  const list = runCli(dataDir, ["list"]);
  assert.match(list.stdout, /ACTIVE/);
  assert.match(list.stdout, /UNUSED/);

  assert.equal(runCli(dataDir, ["revoke", keys[0]]).status, 0);
  assert.equal((await ctx.call("GET", "/api/curriculum", null, { cookie })).status, 401);

  assert.equal(runCli(dataDir, ["reset-sessions", "cli@example.test"]).status, 0);
  assert.equal((await ctx.call("GET", "/api/auth/me", null, { cookie })).json.authenticated, false);
});

test("CLI refuses a mismatched secret and a corrupt store without writing", { skip: !hasPython && "python3 not available" }, () => {
  const dataDir = makeTmp("data");
  assert.equal(runCli(dataDir, ["generate", "--count", "1"]).status, 0);
  const licensesFile = path.join(dataDir, "licenses.json");
  const before = fs.readFileSync(licensesFile, "utf8");

  const wrong = runCli(dataDir, ["generate", "--count", "1"], { LICENSE_SECRET: "z".repeat(40) });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /KHÔNG khớp/);
  assert.equal(fs.readFileSync(licensesFile, "utf8"), before);

  fs.rmSync(path.join(dataDir, ".license_secret"));
  const missing = runCli(dataDir, ["generate", "--count", "1"]);
  assert.equal(missing.status, 2);
  assert.equal(fs.readFileSync(licensesFile, "utf8"), before);

  fs.writeFileSync(licensesFile, "{ broken");
  const corrupt = runCli(dataDir, ["list"]);
  assert.equal(corrupt.status, 2);
  assert.equal(fs.readFileSync(licensesFile, "utf8"), "{ broken");
  assert.equal(fs.existsSync(path.join(dataDir, ".store.lock")), false);
});

test("bot endpoints respond to FAQ, quiz, reminders, and webhooks", async (t) => {
  const ctx = await startApp(t);

  // 1. FAQ endpoint
  const faqRes = await ctx.call("GET", "/api/bot/faq");
  assert.equal(faqRes.status, 200);
  assert.equal(faqRes.json.ok, true);
  assert.ok(Array.isArray(faqRes.json.faqs));
  assert.ok(faqRes.json.faqs.length >= 5);

  // 2. Daily reminder endpoint
  const remRes = await ctx.call("GET", "/api/bot/remind");
  assert.equal(remRes.status, 200);
  assert.ok(remRes.json.reminder.title);
  assert.match(remRes.json.reminder.message, /NHẮC LỊCH HỌC/);

  // 3. Quiz endpoint
  const quizRes = await ctx.call("GET", "/api/bot/quiz");
  assert.equal(quizRes.status, 200);
  assert.ok(quizRes.json.quiz.q);
  assert.equal(quizRes.json.quiz.options.length, 4);
  assert.ok(typeof quizRes.json.quiz.answer === "number");

  // 4. Telegram Webhook: /start
  const tgStart = await ctx.call("POST", "/api/bot/telegram", {
    message: { text: "/start", chat: { id: 4242 } }
  }, { "x-telegram-bot-api-secret-token": TG_SECRET });
  assert.equal(tgStart.status, 200);
  assert.match(tgStart.json.text, /Chào bạn! Tôi là Bot Trợ Giảng/);
  // Webhook replies must name the Bot API method or Telegram sends nothing.
  assert.equal(tgStart.json.method, "sendMessage");
  assert.equal(tgStart.json.chat_id, 4242);
  assert.ok(tgStart.json.reply_markup.inline_keyboard);

  // 5. Telegram Webhook: FAQ query
  const tgFaq = await ctx.call("POST", "/api/bot/telegram", {
    message: { text: "giá gói pro là bao nhiêu", chat: { id: 4242 } }
  }, { "x-telegram-bot-api-secret-token": TG_SECRET });
  assert.equal(tgFaq.status, 200);
  assert.match(tgFaq.json.text, /GÓI PRO AI LAB/);

  // 6. Telegram Webhook: /quiz
  const tgQuiz = await ctx.call("POST", "/api/bot/telegram", {
    message: { text: "/quiz", chat: { id: 4242 } }
  }, { "x-telegram-bot-api-secret-token": TG_SECRET });
  assert.equal(tgQuiz.status, 200);
  assert.match(tgQuiz.json.text, /MINI-QUIZ 1 PHÚT/);

  // Quiz buttons are graded against the real answer position.
  const answerButtons = tgQuiz.json.reply_markup.inline_keyboard[0];
  const correctIdx = Number(answerButtons[0].callback_data.split("_")[3]);
  const pick = (idx) =>
    ctx.call("POST", "/api/bot/telegram", {
      callback_query: { id: "cbq1", data: answerButtons[idx].callback_data, message: { chat: { id: 4242 } } }
    }, { "x-telegram-bot-api-secret-token": TG_SECRET });
  const right = await pick(correctIdx);
  assert.equal(right.json.method, "answerCallbackQuery");
  assert.equal(right.json.callback_query_id, "cbq1");
  assert.match(right.json.text, /Chính xác/);
  const wrong = await pick((correctIdx + 1) % 4);
  assert.match(wrong.json.text, /Chưa đúng.*Đáp án đúng là [A-D]/);

  // Menu buttons answer in the chat they were pressed in.
  for (const [data, pattern] of [["cmd_quiz", /MINI-QUIZ/], ["cmd_upgrade", /200\.000đ/], ["cmd_faq", /CÂU HỎI THƯỜNG GẶP/]]) {
    const btn = await ctx.call("POST", "/api/bot/telegram", {
      callback_query: { id: "cbq2", data, message: { chat: { id: 4242 } } }
    }, { "x-telegram-bot-api-secret-token": TG_SECRET });
    assert.equal(btn.json.method, "sendMessage", data);
    assert.equal(btn.json.chat_id, 4242);
    assert.match(btn.json.text, pattern);
  }

  // Updates without text (stickers, joins...) get an empty 200 reply.
  const sticker = await ctx.call("POST", "/api/bot/telegram", { message: { chat: { id: 4242 }, sticker: {} } },
    { "x-telegram-bot-api-secret-token": TG_SECRET });
  assert.equal(sticker.status, 200);
  assert.equal(sticker.json.method, undefined);

  // 7. Zalo Webhook
  const zalo = zaloSigned({
    event_name: "user_send_text_message",
    message: { text: "học offline được không" }
  });
  const zaloRes = await ctx.call("POST", "/api/bot/zalo", zalo.body, zalo.headers);
  assert.equal(zaloRes.status, 200);
  assert.equal(zaloRes.json.error, 0);
  assert.match(zaloRes.json.reply, /Offline/);

  // 8. License check endpoint
  const [proKey] = await ctx.issueKeys(1, "pro");
  await ctx.register("botuser@example.test", proKey);

  const checkKey = await ctx.call("POST", "/api/bot/check", { query: proKey });
  assert.equal(checkKey.status, 200);
  assert.equal(checkKey.json.found, true);
  assert.equal(checkKey.json.tier, "pro");

  assert.equal(checkKey.json.email, "bo***@example.test"); // masked, never the full email

  // Email lookups are refused so the endpoint cannot enumerate customers.
  const checkEmail = await ctx.call("POST", "/api/bot/check", { query: "botuser@example.test" });
  assert.equal(checkEmail.status, 200);
  assert.equal(checkEmail.json.found, false);
  assert.equal(checkEmail.json.tier, undefined);
  assert.doesNotMatch(checkEmail.json.message, /PRO VIP|botuser/);

  // Key hints / partial keys no longer match.
  const partial = await ctx.call("POST", "/api/bot/check", { query: proKey.slice(0, 8) + proKey.slice(-4) });
  assert.equal(partial.json.found, false);
});

test("security: admin bot routes fail closed without ADMIN_TOKEN", async (t) => {
  const ctx = await startApp(t, { adminToken: "" });
  for (const [method, url] of [
    ["GET", "/api/bot/leads"],
    ["POST", "/api/bot/drip/trigger"],
    ["POST", "/api/bot/remind/trigger"],
  ]) {
    const res = await ctx.call(method, url, method === "POST" ? {} : null, { authorization: "Bearer " });
    assert.equal(res.status, 401, `${method} ${url} must be closed`);
  }
});

test("security: admin bot routes require the exact bearer token", async (t) => {
  const ctx = await startApp(t);
  const bad = await ctx.call("GET", "/api/bot/leads", null, { authorization: "Bearer wrong-token-0123456789abcd" });
  assert.equal(bad.status, 401);
  const none = await ctx.call("GET", "/api/bot/leads");
  assert.equal(none.status, 401);
  const ok = await ctx.call("GET", "/api/bot/leads", null, { authorization: `Bearer ${ADMIN_TOKEN}` });
  assert.equal(ok.status, 200);
});

test("security: webhooks reject missing or forged secrets", async (t) => {
  const ctx = await startApp(t);
  const tgNone = await ctx.call("POST", "/api/bot/telegram", { message: { text: "/start" } });
  assert.equal(tgNone.status, 401);
  const tgBad = await ctx.call("POST", "/api/bot/telegram", { message: { text: "/start" } }, { "x-telegram-bot-api-secret-token": "nope" });
  assert.equal(tgBad.status, 401);

  const zalo = zaloSigned({ event_name: "follow" });
  const zaloOk = await ctx.call("POST", "/api/bot/zalo", zalo.body, zalo.headers);
  assert.equal(zaloOk.status, 200);
  const zaloTampered = await ctx.call("POST", "/api/bot/zalo", { ...zalo.body, event_name: "x" }, zalo.headers);
  assert.equal(zaloTampered.status, 401);
  const zaloNone = await ctx.call("POST", "/api/bot/zalo", { event_name: "follow" });
  assert.equal(zaloNone.status, 401);

  // Unconfigured secrets disable the webhooks entirely.
  const off = await startApp(t, { telegramWebhookSecret: "", zaloOaSecret: "" });
  const tgOff = await off.call("POST", "/api/bot/telegram", { message: { text: "/start" } }, { "x-telegram-bot-api-secret-token": "" });
  assert.equal(tgOff.status, 401);
});

test("security: lead capture needs consent, blocks cross-site posts, is rate limited and escapes HTML", async (t) => {
  const ctx = await startApp(t);
  const ip = { "x-forwarded-for": "203.0.113.50" };

  const noConsent = await ctx.call("POST", "/api/bot/leads", { email: "a@example.test" }, ip);
  assert.equal(noConsent.status, 400);

  const crossSite = await ctx.call(
    "POST",
    "/api/bot/leads",
    { email: "a@example.test", consent: true },
    { ...ip, origin: "https://evil.example" }
  );
  assert.equal(crossSite.status, 403);

  const evilName = '<a href="https://phish.example">Bấm vào đây</a>';
  const ok = await ctx.call("POST", "/api/bot/leads", { email: "lead1@example.test", name: evilName, consent: true }, ip);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.lead, undefined); // no lead record echoed back

  await new Promise((r) => setTimeout(r, 50)); // let the background welcome mail land in the outbox
  const mailer = require("../mailer");
  const outbox = JSON.parse(fs.readFileSync(mailer.OUTBOX_FILE, "utf8")).outbox;
  assert.ok(outbox.some((m) => m.to === "lead1@example.test"));
  const html = mailer.templateWelcomeLead({ email: "lead1@example.test", name: evilName }).html;
  assert.ok(!html.includes('<a href="https://phish.example">'));
  assert.ok(html.includes("&lt;a href=&quot;https://phish.example&quot;&gt;"));

  // Re-submitting the same address does not send a second welcome mail.
  await ctx.call("POST", "/api/bot/leads", { email: "lead1@example.test", consent: true }, ip);
  await new Promise((r) => setTimeout(r, 50));
  const again = JSON.parse(fs.readFileSync(mailer.OUTBOX_FILE, "utf8")).outbox.filter((m) => m.to === "lead1@example.test");
  assert.equal(again.length, 1);

  // 5 requests per 15 minutes per IP: the 400 and both successful posts above already count.
  let last;
  for (let i = 0; i < 5; i++) {
    last = await ctx.call("POST", "/api/bot/leads", { email: `spam${i}@example.test`, consent: true }, ip);
  }
  assert.equal(last.status, 429);
});

test("security: unsubscribe links are signed and GET does not unsubscribe", async (t) => {
  const ctx = await startApp(t);
  const crm = require("../crm");
  const mailer = require("../mailer");
  crm.recordLead({ email: "unsub@example.test", source: "test" });

  const url = new URL(mailer.buildUnsubscribeUrl("unsub@example.test"));
  assert.ok(url.searchParams.get("token"));

  const forged = await ctx.call("GET", `/unsubscribe?email=unsub%40example.test&token=forged`);
  assert.equal(forged.status, 400);

  const page = await ctx.call("GET", `/unsubscribe${url.search}`);
  assert.equal(page.status, 200);
  assert.equal(crm.readLeads().leads.find((l) => l.email === "unsub@example.test").unsubscribed, false);

  const form = new URLSearchParams({ email: "unsub@example.test", token: url.searchParams.get("token") }).toString();
  const done = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: ctx.port, path: "/unsubscribe", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(form) } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }
    );
    req.on("error", reject);
    req.end(form);
  });
  assert.equal(done, 200);
  assert.equal(crm.readLeads().leads.find((l) => l.email === "unsub@example.test").unsubscribed, true);
});

test("security: CRM and outbox files are owner-only (0600)", () => {
  const crm = require("../crm");
  const mailer = require("../mailer");
  crm.recordLead({ email: "perm@example.test", source: "test" });
  assert.equal(fs.statSync(crm.LEADS_FILE).mode & 0o777, 0o600);
  assert.equal(fs.statSync(mailer.OUTBOX_FILE).mode & 0o777, 0o600);
});
