/**
 * Comprehensive Unit & Integration Tests for Omnichannel Bot System (Zalo, Telegram, Email, CRM).
 * Pure Node.js test suite using node:test and node:assert.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Keep CRM / mailer / scheduler writes out of the real Web-Server/data directory.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "bot-system-test-"));
process.env.DATA_DIR = TMP_DATA;
test.after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const mailer = require("../mailer");
const crm = require("../crm");
const botService = require("../bot");
const cronScheduler = require("../cron-scheduler");

test("Mailer: generates valid HTML and logs to outbox in dev mode", async () => {
  const email = "hocvien_test@example.com";
  const welcome = mailer.templateWelcomeLead({ email, name: "Nguyễn Văn A" });
  assert.ok(welcome.subject.includes("Chào mừng bạn"));
  assert.ok(welcome.html.includes("Chương 1: Âm Thanh Lào"));
  assert.ok(welcome.html.includes("Nghị định 13/2023/NĐ-CP"));
  assert.ok(welcome.html.includes("/unsubscribe"));

  const result = await mailer.sendMail({
    to: email,
    subject: welcome.subject,
    html: welcome.html,
    templateId: "welcome"
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "sent");
  assert.ok(["resend", "brevo", "outbox_local", "outbox_dev"].includes(result.provider));

  // Verify outbox file
  const outboxRaw = fs.readFileSync(mailer.OUTBOX_FILE, "utf8");
  const outboxData = JSON.parse(outboxRaw);
  assert.ok(Array.isArray(outboxData.outbox));
  const record = outboxData.outbox.find(m => m.to === email);
  assert.ok(record);
  assert.equal(record.template_id, "welcome");
});

test("Mailer: generates Upsell Pro and License templates accurately", () => {
  const upsell = mailer.templateUpsellPro({
    email: "std_user@example.com",
    name: "Trần Học Viên",
    licenseKey: "LAO-STD-8888-9999"
  });
  assert.ok(upsell.subject.includes("Nâng cấp AI Lab"));
  assert.ok(upsell.html.includes("+200.000đ"));
  assert.ok(upsell.html.includes("Waveform"));

  const licMail = mailer.templateLicenseKey({
    email: "buyer@example.com",
    tier: "pro",
    licenseKey: "LAO-PRO-1234-5678"
  });
  assert.ok(licMail.subject.includes("GÓI PRO AI LAB"));
  assert.ok(licMail.html.includes("LAO-PRO-1234-5678"));
});

test("CRM: manages leads, lifecycle states, and drip sequence progression", () => {
  const testEmail = `lead_test_${Date.now()}@example.com`;
  
  // 1. Record Lead
  const lead = crm.recordLead({
    email: testEmail,
    name: "Lê Văn Test",
    phone_zalo: "0901234567",
    source: "landing_page"
  });
  assert.equal(lead.email, testEmail);
  assert.equal(lead.status, "free_trial");
  assert.equal(lead.drip_step, 0);

  // 2. Lead update
  crm.updateLead(testEmail, { telegram_chat_id: "987654321" });
  let store = crm.readLeads();
  let found = store.leads.find(l => l.email === testEmail);
  assert.equal(found.telegram_chat_id, "987654321");

  // 3. User tier sync (Standard purchase)
  crm.syncUserTier(testEmail, "standard");
  store = crm.readLeads();
  found = store.leads.find(l => l.email === testEmail);
  assert.equal(found.status, "standard");

  // 4. User tier sync (Pro Upgrade)
  crm.syncUserTier(testEmail, "pro");
  store = crm.readLeads();
  found = store.leads.find(l => l.email === testEmail);
  assert.equal(found.status, "pro");

  // 5. Unsubscribe
  crm.unsubscribeLead(testEmail);
  store = crm.readLeads();
  found = store.leads.find(l => l.email === testEmail);
  assert.equal(found.unsubscribed, true);
});

test("Bot: Telegram Webhook handles commands, inline buttons, and upsell", () => {
  const licenses = {
    "LAO-STD-AAAA-1111": { id: "lic_std", tier: "standard", revoked: false, bound_user_id: "u1", bound_email_masked: "us***@example.com" },
    "LAO-PRO-BBBB-2222": { id: "lic_pro", tier: "pro", revoked: false, bound_user_id: null }
  };
  const dummyStore = { findLicenseByKey: (k) => licenses[String(k).trim().toUpperCase()] || null };

  // /start
  const startRes = botService.handleTelegramWebhook({ message: { text: "/start" } }, dummyStore);
  assert.equal(startRes.ok, true);
  assert.match(startRes.text, /Bot Trợ Giảng/);
  assert.ok(startRes.reply_markup && startRes.reply_markup.inline_keyboard);

  // /quiz
  const quizRes = botService.handleTelegramWebhook({ message: { text: "/quiz" } }, dummyStore);
  assert.equal(quizRes.ok, true);
  assert.ok(quizRes.quiz);
  assert.equal(quizRes.reply_markup.inline_keyboard[0].length, 4);

  // /upgrade
  const upRes = botService.handleTelegramWebhook({ message: { text: "/upgrade" } }, dummyStore);
  assert.equal(upRes.ok, true);
  assert.match(upRes.text, /200\.000đ/);
  assert.ok(upRes.reply_markup);

  // /check Standard -> suggests upgrade
  const checkStd = botService.handleTelegramWebhook({ message: { text: "/check LAO-STD-AAAA-1111" } }, dummyStore);
  assert.equal(checkStd.ok, true);
  assert.match(checkStd.text, /STANDARD/);
  assert.match(checkStd.text, /bù 200\.000đ/);

  // /check Pro
  const checkPro = botService.handleTelegramWebhook({ message: { text: "/check LAO-PRO-BBBB-2222" } }, dummyStore);
  assert.equal(checkPro.ok, true);
  assert.match(checkPro.text, /PRO VIP/);

  // Email lookups and partial keys are refused
  const checkEmail = botService.handleTelegramWebhook({ message: { text: "/check user_pro@example.com" } }, dummyStore);
  assert.match(checkEmail.text, /không tra cứu theo email/);
  const checkPartial = botService.handleTelegramWebhook({ message: { text: "/check LAO-PRO-2222" } }, dummyStore);
  assert.match(checkPartial.text, /Không tìm thấy/);

  // Callback Query handling: answer is graded against the encoded correct option
  const cbRight = botService.handleTelegramWebhook({
    callback_query: { id: "cb_123", data: "quiz_ans_2_2", from: { id: 111 } }
  }, dummyStore);
  assert.equal(cbRight.type, "callback_answer");
  assert.match(cbRight.text, /Chính xác/);
  const cbWrong = botService.handleTelegramWebhook({
    callback_query: { id: "cb_124", data: "quiz_ans_0_2", from: { id: 111 } }
  }, dummyStore);
  assert.match(cbWrong.text, /Đáp án đúng là C/);

  // Every quiz button encodes the same correct index as the quiz itself
  const q = botService.handleTelegramWebhook({ message: { text: "/quiz", chat: { id: 1 } } }, dummyStore);
  for (const btn of q.reply_markup.inline_keyboard[0]) {
    assert.ok(btn.callback_data.endsWith(`_${q.quiz.answer}`));
    assert.ok(Buffer.byteLength(btn.callback_data) <= 64);
  }

  // Webhook reply mapping
  const mapped = botService.toTelegramWebhookReply(cbRight);
  assert.equal(mapped.method, "answerCallbackQuery");
  assert.equal(botService.toTelegramWebhookReply({ ok: true, text: "no chat" }), null);
});

test("Bot: Zalo Webhook handles follow event and FAQ matching", () => {
  const dummyStore = { licenses: [], users: [] };

  // Follow event
  const followRes = botService.handleZaloWebhook({ event_name: "follow" }, dummyStore);
  assert.equal(followRes.error, 0);
  assert.match(followRes.reply, /Sabaidee/);
  assert.match(followRes.reply, /Chương 1/);

  // FAQ Text event
  const faqRes = botService.handleZaloWebhook({
    event_name: "user_send_text_message",
    message: { text: "nâng cấp lên pro bù bao nhiêu tiền" }
  }, dummyStore);
  assert.equal(faqRes.error, 0);
  assert.match(faqRes.reply, /200\.000đ/);
});

test("VietQR: generates valid QR URL schema", () => {
  const qrUrl = botService.generateVietQrUrl({
    amount: 200000,
    addInfo: "UPGRADE PRO HOCVIEN",
    bankBin: "970422",
    accountNo: "0123456789"
  });
  assert.ok(qrUrl.startsWith("https://img.vietqr.io/image/970422-0123456789-compact2.png"));
  assert.ok(qrUrl.includes("amount=200000"));
  assert.ok(qrUrl.includes("addInfo=UPGRADE%20PRO%20HOCVIEN"));
});

test("Scheduler: runs drip cycle and creates campaign logs safely", async () => {
  const summary = await cronScheduler.processDripCycle();
  assert.ok(typeof summary.sent === "number");
  assert.ok(typeof summary.total_due === "number");

  const logsRaw = fs.readFileSync(cronScheduler.CAMPAIGN_LOGS_FILE, "utf8");
  const logs = JSON.parse(logsRaw);
  assert.ok(Array.isArray(logs.logs));
  assert.ok(logs.logs.length >= 1);
});
