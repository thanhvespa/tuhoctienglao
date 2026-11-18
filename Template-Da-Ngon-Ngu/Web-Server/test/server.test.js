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

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const srv = require(path.join(PROJECT_ROOT, "Web-Server", "server.js"));
const CLI = path.join(PROJECT_ROOT, "tools", "license_cli.py");

const SESSION_SECRET = "s".repeat(40);
const ADMIN_TOKEN = "admin-token-for-tests-0123456789";
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
    adminToken: ADMIN_TOKEN,
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

  const issueKeys = async (count = 1) => {
    const res = await call("POST", "/api/admin/licenses/generate", { count }, { authorization: `Bearer ${ADMIN_TOKEN}` });
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
