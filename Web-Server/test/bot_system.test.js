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

test("VietQR: uses the configured receiving account and never a placeholder", () => {
  const qrUrl = botService.generateVietQrUrl({ addInfo: "Nâng cấp PRO hocvien@gmail.com" });
  assert.ok(qrUrl.startsWith("https://img.vietqr.io/image/970412-888686863979-compact2.png?"));
  assert.ok(qrUrl.includes("accountName=NGUYEN%20DO%20THANH"));
  assert.ok(qrUrl.includes("amount=200000"));
  // Diacritics and "@" are stripped, note capped at 25 chars
  const note = new URL(qrUrl).searchParams.get("addInfo");
  assert.match(note, /^[A-Z0-9 ]{1,25}$/);
  assert.ok(note.startsWith("NANG CAP PRO"));

  // No account configured -> no QR at all
  assert.equal(botService.generateVietQrUrl({ bankBin: "", accountNo: "" }), "");

  const offer = botService.generateUpsellOffer({});
  assert.match(offer.text, /PVcomBank/);
  assert.match(offer.text, /888686863979/);
  assert.equal(offer.reply_markup.inline_keyboard[0][0].url, offer.qr_url);
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

test("Support: Zalo links point to the configured personal number", () => {
  const start = botService.handleTelegramWebhook({ message: { text: "/start", chat: { id: 5 } } }, null, null);
  const urls = start.reply_markup.inline_keyboard.flat().map((b) => b.url).filter(Boolean);
  assert.ok(urls.includes("https://zalo.me/0944888929"));
  assert.ok(!JSON.stringify(start).includes("zalo.me/tuhoctienglao"));
  const buttons = start.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes("cmd_contact_admin"));
});

test("Telegram: /ad relays learner <-> admin when configured", () => {
  const prevAdmin = process.env.TELEGRAM_ADMIN_CHAT_ID;
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;
  try {
    // Not configured: falls back to Zalo info, nothing relayed
    delete process.env.TELEGRAM_ADMIN_CHAT_ID;
    const noRelay = botService.handleTelegramWebhook(
      { message: { message_id: 1, text: "/ad hello", chat: { id: 111, type: "private" } } }, null, null);
    assert.equal(noRelay.relay, undefined);
    assert.match(noRelay.text, /0944888929/);

    process.env.TELEGRAM_ADMIN_CHAT_ID = "999";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";

    // Button press shows instructions
    const cb = botService.handleTelegramWebhook(
      { callback_query: { id: "cb1", data: "cmd_contact_admin", message: { chat: { id: 111 } } } }, null, null);
    assert.equal(cb.type, "callback_message");
    assert.match(cb.text, /\/ad/);

    // Learner text -> admin
    const sent = botService.handleTelegramWebhook({
      message: { message_id: 2, text: "/ad Mình đã chuyển khoản", chat: { id: 111, type: "private" }, from: { first_name: "An", username: "an_lao" } }
    }, null, null);
    assert.equal(sent.type, "relay_to_admin");
    assert.equal(sent.relay.method, "sendMessage");
    assert.equal(sent.relay.payload.chat_id, "999");
    assert.match(sent.relay.payload.text, /#u111/);
    assert.match(sent.relay.payload.text, /Mình đã chuyển khoản/);
    assert.equal(botService.toTelegramWebhookReply(sent).chat_id, 111);

    // Learner photo -> copied to admin with tag
    const photo = botService.handleTelegramWebhook({
      message: { message_id: 3, photo: [{ file_id: "x" }], chat: { id: 111, type: "private" } }
    }, null, null);
    assert.equal(photo.relay.method, "copyMessage");
    assert.match(photo.relay.payload.caption, /#u111/);

    // Admin replies to the relayed message -> goes to the learner
    const reply = botService.handleTelegramWebhook({
      message: { message_id: 4, text: "Đã nâng cấp xong!", chat: { id: 999, type: "private" }, reply_to_message: { text: sent.relay.payload.text } }
    }, null, null);
    const wh = botService.toTelegramWebhookReply(reply);
    assert.equal(wh.method, "sendMessage");
    assert.equal(wh.chat_id, "111");
    assert.match(wh.text, /Đã nâng cấp xong!/);

    // Admin's normal messages still use the bot normally
    const adminNormal = botService.handleTelegramWebhook({ message: { text: "/myid", chat: { id: 999 } } }, null, null);
    assert.match(adminNormal.text, /999/);

    // Group chats are never relayed
    const group = botService.handleTelegramWebhook(
      { message: { message_id: 5, text: "/ad hi", chat: { id: -100, type: "group" } } }, null, null);
    assert.equal(group.relay, undefined);
  } finally {
    if (prevAdmin === undefined) delete process.env.TELEGRAM_ADMIN_CHAT_ID; else process.env.TELEGRAM_ADMIN_CHAT_ID = prevAdmin;
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prevToken;
  }
});

test("Telegram: Admin Key Generation & Customer VietQR 1-Tap Purchase Flow", () => {
  const prevAdmin = process.env.TELEGRAM_ADMIN_CHAT_ID;
  process.env.TELEGRAM_ADMIN_CHAT_ID = "999";

  const issued = [];
  const dummyStore = {
    findLicenseByKey: () => null,
    issueLicenses: ({ tier, count, note }) => {
      const keys = [];
      for (let i = 0; i < count; i++) {
        const k = `LAO-${tier === "pro" ? "PRO" : "STD"}-TEST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        keys.push(k);
        issued.push({ key: k, tier, note });
      }
      return keys;
    },
    getLicenseStats: () => ({
      total: 10,
      standard: { total: 6, unused: 4 },
      pro: { total: 4, unused: 2 }
    })
  };

  try {
    // 1. /admin command authorization
    const nonAdmin = botService.handleTelegramWebhook({ message: { text: "/admin", chat: { id: 123 }, from: { id: 123 } } }, dummyStore);
    assert.match(nonAdmin.text, /Quản trị viên/);

    const adminReq = botService.handleTelegramWebhook({ message: { text: "/admin", chat: { id: 999 }, from: { id: 999 } } }, dummyStore);
    assert.match(adminReq.text, /MENU QUẢN TRỊ/);
    assert.ok(adminReq.reply_markup && adminReq.reply_markup.inline_keyboard);

    // 2. Admin button clicks to generate keys
    const genStd = botService.handleTelegramWebhook({
      callback_query: { id: "cb_admin1", data: "admin_gen_std", message: { chat: { id: 999 } }, from: { id: 999 } }
    }, dummyStore);
    assert.match(genStd.text, /LAO-STD-TEST-/);
    assert.equal(issued.length, 1);
    assert.equal(issued[0].tier, "standard");

    const genPro = botService.handleTelegramWebhook({
      callback_query: { id: "cb_admin2", data: "admin_gen_pro", message: { chat: { id: 999 } }, from: { id: 999 } }
    }, dummyStore);
    assert.match(genPro.text, /LAO-PRO-TEST-/);
    assert.equal(issued.length, 2);
    assert.equal(issued[1].tier, "pro");

    // Admin stats
    const stats = botService.handleTelegramWebhook({
      callback_query: { id: "cb_admin3", data: "admin_stats", message: { chat: { id: 999 } }, from: { id: 999 } }
    }, dummyStore);
    assert.match(stats.text, /THỐNG KÊ BẢN QUYỀN/);
    assert.match(stats.text, /Standard: 6/);

    // 3. Customer Buy Flow: /buy
    const buyMenu = botService.handleTelegramWebhook({ message: { text: "/buy", chat: { id: 111 } } }, dummyStore);
    assert.match(buyMenu.text, /ĐĂNG KÝ BẢN QUYỀN/);
    assert.ok(buyMenu.reply_markup);

    // Customer selects PRO
    const selectPro = botService.handleTelegramWebhook({
      callback_query: { id: "cb_buy_pro", data: "buy_pro", message: { chat: { id: 111 } }, from: { id: 111 } }
    }, dummyStore);
    assert.match(selectPro.text, /499\.000đ/);
    assert.match(selectPro.text, /THÔNG TIN CHUYỂN KHOẢN/);

    // Customer clicks "I paid"
    const orderBtn = selectPro.reply_markup.inline_keyboard[0][0];
    assert.ok(orderBtn.callback_data.startsWith("paid_LAOPRO"));
    const paidCb = botService.handleTelegramWebhook({
      callback_query: { id: "cb_paid", data: orderBtn.callback_data, message: { chat: { id: 111 } }, from: { id: 111, first_name: "HocVien" } }
    }, dummyStore);
    assert.match(paidCb.text, /ĐÃ GHI NHẬN YÊU CẦU THANH TOÁN/);
    assert.ok(paidCb.relay);
    assert.equal(paidCb.relay.payload.chat_id, "999");
    assert.match(paidCb.relay.payload.text, /ĐƠN HÀNG MỚI CHỜ DUYỆT/);

    // 4. Admin clicks "Approve" button
    const approveBtn = paidCb.relay.payload.reply_markup.inline_keyboard[0][0];
    assert.ok(approveBtn.callback_data.startsWith("appr_LAOPRO"));
    const approveCb = botService.handleTelegramWebhook({
      callback_query: { id: "cb_appr", data: approveBtn.callback_data, message: { chat: { id: 999 } }, from: { id: 999 } }
    }, dummyStore);
    assert.match(approveCb.text, /ĐÃ DUYỆT ĐƠN HÀNG/);
    assert.ok(Array.isArray(approveCb.extra_dispatches));
    assert.equal(approveCb.extra_dispatches.length, 1);
    assert.equal(approveCb.extra_dispatches[0].payload.chat_id, "111");
    assert.match(approveCb.extra_dispatches[0].payload.text, /MÃ KÍCH HOẠT CỦA BẠN/);
    assert.match(approveCb.extra_dispatches[0].payload.text, /LAO-PRO-TEST-/);

    // 5. Admin clicks "Reject" button
    const rejBtn = paidCb.relay.payload.reply_markup.inline_keyboard[1][0];
    const rejCb = botService.handleTelegramWebhook({
      callback_query: { id: "cb_rej", data: rejBtn.callback_data, message: { chat: { id: 999 } }, from: { id: 999 } }
    }, dummyStore);
    assert.match(rejCb.text, /ĐÃ TỪ CHỐI ĐƠN HÀNG/);
    assert.equal(rejCb.extra_dispatches[0].payload.chat_id, "111");
    assert.match(rejCb.extra_dispatches[0].payload.text, /chưa thấy khoản tiền/);
  } finally {
    if (prevAdmin === undefined) delete process.env.TELEGRAM_ADMIN_CHAT_ID; else process.env.TELEGRAM_ADMIN_CHAT_ID = prevAdmin;
  }
});
