/**
 * In-memory Mock HTTP Integration Tests for Bot & CRM Endpoints in server.js.
 * Tests route dispatching, CSRF whitelist for bots, JSON responses without needing open sockets.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// Keep CRM / mailer writes out of the real Web-Server/data directory.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "bot-routes-test-"));
process.env.DATA_DIR = TMP_DATA;
test.after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const { createCourseApp: createApp } = require("../server");

const TG_SECRET = "telegram-webhook-secret-0123456789";
const ZALO_SECRET = "zalo-oa-secret-key-0123456789abcd";
const ZALO_APP_ID = "1234567890";

function createCourseApp() {
  return createApp({
    dataDir: TMP_DATA,
    secret: "s".repeat(40),
    licenseSecret: "l".repeat(40),
    adminToken: "admin-token-for-tests-0123456789",
    telegramWebhookSecret: TG_SECRET,
    zaloOaSecret: ZALO_SECRET,
    zaloAppId: ZALO_APP_ID,
  });
}

function mockRequest({ method = "GET", url = "/", headers = {}, body = null }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:8787", ...headers };
  req.socket = { remoteAddress: "127.0.0.1" };

  process.nextTick(() => {
    if (body) {
      const data = typeof body === "string" ? body : JSON.stringify(body);
      req.emit("data", Buffer.from(data));
    }
    req.emit("end");
  });

  return req;
}

function mockResponse() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.body = "";

  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v;
  };
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    if (headers) Object.assign(res.headers, headers);
  };
  res.write = (chunk) => {
    if (chunk) res.body += chunk.toString();
  };
  res.end = (chunk) => {
    if (chunk) res.body += chunk.toString();
    res.emit("finish");
  };

  return res;
}

function callRoute(app, opts) {
  return new Promise((resolve) => {
    const req = mockRequest(opts);
    const res = mockResponse();
    res.on("finish", () => {
      let json = null;
      try {
        json = JSON.parse(res.body);
      } catch (_) {}
      resolve({ status: res.statusCode, headers: res.headers, body: res.body, json });
    });
    app.handleRequest(req, res);
  });
}

test("Server Bot Routes: /api/bot/upgrade returns upsell payload with VietQR", async () => {
  const app = createCourseApp();
  const res = await callRoute(app, {
    method: "GET",
    url: "/api/bot/upgrade"
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.upgrade.upgrade_price, 200000);
  assert.ok(res.json.upgrade.qr_url.includes("amount=200000"));
});

test("Server Bot Routes: /api/bot/leads captures new lead and returns success", async () => {
  const app = createCourseApp();
  const testEmail = `route_lead_${Date.now()}@example.com`;
  const res = await callRoute(app, {
    method: "POST",
    url: "/api/bot/leads",
    headers: { "content-type": "application/json" },
    body: {
      name: "Khách Hàng Mới",
      email: testEmail,
      phone: "0988776655",
      source: "landing_page_ebook",
      consent: true
    }
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.message, /Đăng ký nhận tài liệu và học thử thành công/);
});

test("Server Bot Routes: /api/bot/telegram handles /upgrade and returns 200k offer", async () => {
  const app = createCourseApp();
  const res = await callRoute(app, {
    method: "POST",
    url: "/api/bot/telegram",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET },
    body: {
      message: { text: "/upgrade", chat: { id: 777 } }
    }
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.method, "sendMessage");
  assert.equal(res.json.chat_id, 777);
  assert.match(res.json.text, /200\.000đ/);
  assert.ok(res.json.reply_markup);
});

test("Server Bot Routes: /api/bot/zalo handles follow event", async () => {
  const app = createCourseApp();
  const body = { app_id: ZALO_APP_ID, timestamp: String(Date.now()), event_name: "follow" };
  const raw = JSON.stringify(body);
  const mac = crypto.createHash("sha256").update(ZALO_APP_ID + raw + body.timestamp + ZALO_SECRET).digest("hex");
  const res = await callRoute(app, {
    method: "POST",
    url: "/api/bot/zalo",
    headers: { "content-type": "application/json", "x-zevent-signature": `mac=${mac}` },
    body: raw
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.error, 0);
  assert.match(res.json.reply, /Sabaidee/);
});
