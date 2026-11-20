/**
 * Omnichannel Bot Service for Telegram & Zalo integrations.
 * Supports:
 * - Knowledge base FAQ matching (Course, Pricing, Policies, Decree 13/2023/ND-CP).
 * - Daily 15-minute study reminders by chapter.
 * - 1-minute vocabulary/dialogue micro-quizzes with interactive inline callbacks.
 * - License key & account tier lookup (Standard vs Pro).
 * - Automated Upsell funnel (Standard 299k -> Pro 499k, bù 200.000đ).
 * - Webhook handlers for Telegram Bot API (commands & callback queries) & Zalo OA events.
 * - Direct Telegram API outbound caller.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

/**
 * Bank account that receives payments (shown in VietQR codes). Read from the
 * `payment` section of course.config.json; env vars override it per deploy.
 */
function readCourseConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "course.config.json"), "utf8")) || {};
  } catch (_) {
    return {}; // Config missing: fall back to env vars only
  }
}
const COURSE_CONFIG = readCourseConfig();

function loadPaymentConfig() {
  const cfg = COURSE_CONFIG.payment || {};
  return {
    bankBin: String(process.env.PAYMENT_BANK_BIN || cfg.bank_bin || ""),
    bankName: String(process.env.PAYMENT_BANK_NAME || cfg.bank_name || ""),
    accountNo: String(process.env.PAYMENT_ACCOUNT_NO || cfg.account_no || ""),
    accountName: String(process.env.PAYMENT_ACCOUNT_NAME || cfg.account_name || ""),
    upgradeProAmount: Number(cfg.upgrade_pro_amount) || 200000,
  };
}
const PAYMENT = loadPaymentConfig();

/**
 * Support contact. Zalo is a personal number for now (no Zalo OA yet); a
 * personal zalo.me link cannot prefill a message, so no ?text= is added.
 */
const SUPPORT = (() => {
  const cfg = COURSE_CONFIG.support || {};
  const phone = String(process.env.SUPPORT_ZALO_PHONE || cfg.zalo_phone || "").replace(/[^0-9]/g, "");
  const zaloUrl = String(process.env.SUPPORT_ZALO_URL || cfg.zalo_url || (phone ? `https://zalo.me/${phone}` : ""));
  return { zaloPhone: phone, zaloUrl };
})();

/**
 * Telegram chat id of the admin's own (personal) Telegram account. Messages
 * sent to the bot with /ad are relayed there, and the admin answers by
 * replying to the relayed message. Read on each call so tests can set it.
 */
function getAdminChatId() {
  const id = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
  return /^-?\d{1,20}$/.test(id) ? id : "";
}

// Per-chat relay limit so one user cannot flood the admin's phone.
const RELAY_LIMIT = 8;
const RELAY_WINDOW_MS = 10 * 60 * 1000;
const relayLog = new Map();
function allowRelay(chatId) {
  const now = Date.now();
  const key = String(chatId);
  const recent = (relayLog.get(key) || []).filter((t) => now - t < RELAY_WINDOW_MS);
  if (recent.length >= RELAY_LIMIT) {
    relayLog.set(key, recent);
    return false;
  }
  recent.push(now);
  relayLog.set(key, recent);
  if (relayLog.size > 5000) relayLog.delete(relayLog.keys().next().value);
  return true;
}

// Tag placed in every relayed message; the admin's reply is routed by it.
const RELAY_TAG_RE = /#u(-?\d{1,20})\b/;

function describeSender(from, chatId) {
  const f = from || {};
  const name = [f.first_name, f.last_name].filter(Boolean).join(" ").slice(0, 80) || "Học viên";
  const user = f.username ? ` @${String(f.username).slice(0, 40)}` : "";
  return `${name}${user} #u${chatId}`;
}

const FAQ_DATABASE = [
  {
    id: "faq_intro",
    keywords: ["giới thiệu", "khoá học", "phương pháp", "pimsleur", "học như thế nào", "tiếng lào"],
    question: "Khóa học này dạy theo phương pháp gì và có gì đặc biệt?",
    answer: "Khóa học áp dụng phương pháp Nghe – Nói Phản Xạ Pimsleur cải tiến kết hợp Flashcard tương tác. Toàn bộ 8 chương gồm 840 câu thoại mẫu chuẩn giọng Vientiane, tập trung phản xạ 3 giây, tự chấm điểm và học offline mọi lúc mọi nơi trên ứng dụng PWA."
  },
  {
    id: "faq_pricing",
    keywords: ["giá", "bảng giá", "bao nhiêu tiền", "chi phí", "gói", "standard", "pro", "mua"],
    question: "Bảng giá và sự khác biệt giữa Gói Standard và Gói Pro AI Lab là gì?",
    answer: "Khóa học có 2 gói bản quyền trọn đời:\n• GÓI STANDARD (299.000đ): Toàn bộ 8 chương, 840 audio bản xứ, PWA offline, đồng bộ 3 thiết bị, tự thu âm nghe lại.\n• GÓI PRO AI LAB (499.000đ): Toàn bộ quyền lợi Standard + Phòng Lab phát âm AI (Waveform trực quan, chấm điểm % thanh điệu, phân tích âm điệu bản xứ) + Bot 1-1 hỗ trợ nhắc học & quiz hằng ngày."
  },
  {
    id: "faq_upgrade",
    keywords: ["nâng cấp", "lên pro", "bù tiền", "bù bao nhiêu", "upgrade", "chuyển gói"],
    question: "Tôi đã mua Gói Standard thì nâng cấp lên Gói PRO AI Lab như thế nào?",
    answer: "Bạn chỉ cần bù đúng phần chênh lệch: 200.000đ (thay vì mua mới 499.000đ)! Bạn sẽ được giữ nguyên tiến độ học và mã tài khoản được nâng thẳng lên hạng PRO VIP để mở khóa phòng lab so sánh sóng âm waveform."
  },
  {
    id: "faq_license",
    keywords: ["mã", "kích hoạt", "license", "key", "nhập mã", "cách kích hoạt", "đăng ký"],
    question: "Cách kích hoạt mã khóa học như thế nào?",
    answer: "Sau khi thanh toán, bạn sẽ nhận được mã dạng LAO-STD-XXXX-XXXX (Standard) hoặc LAO-PRO-XXXX-XXXX (Pro). Bạn chỉ cần truy cập app tại https://tuhoctienglao.online/Slide-Tuong-Tac/, bấm '🔑 Đăng nhập / Kích hoạt', điền Email, Mật khẩu và Mã kích hoạt để mở khóa ngay lập tức."
  },
  {
    id: "faq_pwa",
    keywords: ["cài đặt", "app", "pwa", "iphone", "android", "máy tính", "offline", "không mạng"],
    question: "Có cài được lên điện thoại và học khi không có mạng (Offline) không?",
    answer: "Có! Ứng dụng là PWA (Progressive Web App). Trên iPhone/Safari: Bấm nút Chia sẻ (Share) -> 'Thêm vào MH chính' (Add to Home Screen). Trên Android/Chrome: Bấm 'Cài App'. Trong app, bấm '📥 Lưu Offline' để tải sẵn toàn bộ audio về máy học không cần mạng internet."
  },
  {
    id: "faq_policy",
    keywords: ["chính sách", "bảo mật", "dữ liệu", "nghị định 13", "giọng nói", "quyền riêng tư"],
    question: "Chính sách bảo vệ dữ liệu cá nhân theo Nghị định 13/2023/NĐ-CP được thực hiện như thế nào?",
    answer: "Khóa học tuân thủ nghiêm ngặt Nghị định 13/2023/NĐ-CP: Mọi dữ liệu thu âm luyện giọng được phân tích 100% cục bộ trong bộ nhớ trình duyệt qua Web Audio API, không upload lên máy chủ. Thông tin tài khoản được băm mã hóa scrypt bảo mật cao và bạn có quyền yêu cầu xóa/xuất dữ liệu bất kỳ lúc nào."
  },
  {
    id: "faq_devices",
    keywords: ["thiết bị", "mấy máy", "đăng nhập", "đổi máy", "quên mật khẩu"],
    question: "Một tài khoản đăng nhập được trên bao nhiêu thiết bị?",
    answer: "Mỗi tài khoản được đăng nhập tối đa 3 thiết bị cùng lúc (ví dụ: Điện thoại, Máy tính bảng và Laptop). Bạn có thể bấm '🔒 Thoát hết' trong app để thu hồi phiên đăng nhập từ xa bất cứ khi nào đổi thiết bị mới."
  }
];

const DAILY_REMINDERS = [
  { day: 1, chapter: 1, title: "Chương 1: Chào hỏi, Làm quen & Phép lịch sự", goal: "Luyện 15 phút 10 câu chào hỏi sinh tồn đầu tiên." },
  { day: 2, chapter: 2, title: "Chương 2: Hỏi đường, Xe cộ & Di chuyển", goal: "Thực hành hỏi giá tuk-tuk và hướng đi chợ Sáng." },
  { day: 3, chapter: 3, title: "Chương 3: Ẩm thực, Quán ăn & Đi chợ", goal: "Gọi món Tam Maak Hoong (nộm đu đủ) và đếm tiền Kip." },
  { day: 4, chapter: 4, title: "Chương 4: Mua sắm & Mặc cả khéo léo", goal: "Luyện câu mặc cả: 'Lọt đạy bò?' (Giảm giá được không?)." },
  { day: 5, chapter: 5, title: "Chương 5: Khách sạn, Nhà nghỉ & Thuê xe", goal: "Đặt phòng và hỏi mật khẩu Wi-Fi bằng tiếng Lào." },
  { day: 6, chapter: 6, title: "Chương 6: Tình huống khẩn cấp & Y tế", goal: "Nắm vững các câu cần giúp đỡ và hỏi hiệu thuốc." },
  { day: 7, chapter: 7, title: "Chương 7: Giao tiếp công việc & Kết bạn", goal: "Thực hành giới thiệu nghề nghiệp và số điện thoại." },
  { day: 8, chapter: 8, title: "Chương 8: Đời sống văn hóa & Lễ hội", goal: "Chúc Tết Bunpimay 'Sabaidee Pee Mai' đúng điệu." }
];

function matchFaq(text) {
  if (!text || typeof text !== "string") return null;
  const q = text.toLowerCase().trim();
  let bestMatch = null;
  let maxScore = 0;

  for (const item of FAQ_DATABASE) {
    let score = 0;
    for (const kw of item.keywords) {
      if (q.includes(kw)) score += kw.length;
    }
    if (score > maxScore) {
      maxScore = score;
      bestMatch = item;
    }
  }

  return maxScore >= 3 ? bestMatch : null;
}

function getDailyReminder() {
  const dayIndex = new Date().getDay(); // 0-6
  const item = DAILY_REMINDERS[dayIndex % DAILY_REMINDERS.length];
  return {
    chapter: item.chapter,
    title: item.title,
    goal: item.goal,
    message: `⏰ [NHẮC LỊCH HỌC 15 PHÚT HÔM NAY]\n📖 ${item.title}\n🎯 Mục tiêu: ${item.goal}\n👉 Mở app luyện ngay: https://tuhoctienglao.online/Slide-Tuong-Tac/`
  };
}

function generateMicroQuiz(courseData) {
  const fallbackQuizzes = [
    {
      q: "Từ tiếng Lào 'ສະບາຍດີ' (Sabaidee) có nghĩa là gì?",
      options: ["A. Xin chào / Chúc bình an", "B. Cảm ơn", "C. Tạm biệt", "D. Xin lỗi"],
      answer: 0,
      explain: "ສະບາຍດີ (Sabaidee) là câu chào phổ biến nhất trong tiếng Lào, dùng cho mọi thời điểm trong ngày."
    },
    {
      q: "Để hỏi giá 'Cái này bao nhiêu tiền?', người Lào nói thế nào?",
      options: ["A. Lọt đạy bò?", "B. An ni thao đạy?", "C. Khoy yak pay...", "D. Khop chay"],
      answer: 1,
      explain: "ອັນນີ້ເທົ່າໃດ? (An ni thao đạy?) có nghĩa là 'Cái này bao nhiêu tiền?'."
    },
    {
      q: "Khi nhận được sự giúp đỡ, câu 'Cảm ơn nhiều' trong tiếng Lào là:",
      options: ["A. Khop chay lai lai", "B. Bor pen nyang", "C. Yim di", "D. Chok di"],
      answer: 0,
      explain: "ຂອບໃຈຫຼາຍໆ (Khop chay lai lai) nghĩa là 'Cảm ơn rất nhiều'."
    },
    {
      q: "Đáp lại lời cảm ơn, 'Không có gì / Không sao đâu' là:",
      options: ["A. Sabaidee", "B. Bor pen nyang", "C. Sok dee", "D. La khon"],
      answer: 1,
      explain: "ບໍ່ເປັນຫຍັງ (Bor pen nyang) là nét văn hóa đặc trưng của người Lào, nghĩa là 'Không sao đâu / Chẳng sao cả'."
    }
  ];

  if (!courseData || !courseData.chapters || !courseData.chapters.length) {
    const idx = Math.floor(Math.random() * fallbackQuizzes.length);
    return fallbackQuizzes[idx];
  }

  const allVocab = [];
  for (const ch of courseData.chapters) {
    for (const l of ch.lessons || []) {
      for (const v of l.vocab || []) {
        if (v.lao && v.vi) allVocab.push(v);
      }
    }
  }

  if (allVocab.length < 4) {
    return fallbackQuizzes[0];
  }

  const targetIdx = Math.floor(Math.random() * allVocab.length);
  const target = allVocab[targetIdx];

  const distractors = [];
  const used = new Set([targetIdx]);
  while (distractors.length < 3 && distractors.length < allVocab.length - 1) {
    const r = Math.floor(Math.random() * allVocab.length);
    if (!used.has(r)) {
      used.add(r);
      distractors.push(allVocab[r]);
    }
  }

  const correctPos = Math.floor(Math.random() * 4);
  const options = [];
  const letters = ["A", "B", "C", "D"];
  let dIdx = 0;

  for (let i = 0; i < 4; i++) {
    if (i === correctPos) {
      options.push(`${letters[i]}. ${target.lao} (${target.phonetic || ""})`);
    } else {
      const d = distractors[dIdx++];
      options.push(`${letters[i]}. ${d.lao} (${d.phonetic || ""})`);
    }
  }

  return {
    q: `Từ tiếng Lào nào dưới đây có nghĩa là: "${target.vi}"?`,
    options,
    answer: correctPos,
    target_vi: target.vi,
    target_lao: target.lao,
    phonetic: target.phonetic || "",
    explain: `Đáp án đúng là ${letters[correctPos]}: ${target.lao} (${target.phonetic || ""}) có nghĩa là "${target.vi}".`
  };
}

/**
 * License lookup for the bots and /api/bot/check.
 *
 * Security: only an exact, full activation key is accepted. The server injects
 * `store.findLicenseByKey(rawKey)` (HMAC hash comparison), so partial keys,
 * key hints and email addresses can never be used to enumerate customers.
 * The response only ever contains the masked bound email.
 */
function checkLicenseInfo(query, store) {
  const raw = String(query || "").trim();
  if (!raw || !store) return { found: false, message: "Vui lòng nhập mã kích hoạt đầy đủ để tra cứu (dạng LAO-STD-XXXX-XXXX)." };

  if (raw.includes("@")) {
    return {
      found: false,
      message: "🔒 Vì lý do bảo mật, bot không tra cứu theo email. Vui lòng nhập đầy đủ mã kích hoạt (LAO-STD-XXXX-XXXX / LAO-PRO-XXXX-XXXX)."
    };
  }

  const lic = typeof store.findLicenseByKey === "function" ? store.findLicenseByKey(raw) : null;
  if (!lic) {
    return {
      found: false,
      message: "Không tìm thấy mã kích hoạt này. Hãy kiểm tra lại mã LAO-STD-XXXX-XXXX / LAO-PRO-XXXX-XXXX."
    };
  }

  const tier = lic.tier === "pro" ? "pro" : "standard";
  const tierName = tier === "pro" ? "👑 GÓI PRO VIP (Kèm AI Lab)" : "⭐ GÓI STANDARD (Tiêu chuẩn)";
  const boundLabel = lic.bound_user_id ? (lic.bound_email_masked || "Đã gắn tài khoản") : "Mã sẵn sàng kích hoạt";
  const revoked = !!lic.revoked;

  let upsellNotice = "";
  if (tier !== "pro" && !revoked) {
    upsellNotice = "\n\n💡 Bạn đang dùng gói Standard. Nâng cấp lên Gói PRO AI Lab (phòng lab sóng âm & chấm điểm thanh điệu) chỉ bù 200.000đ! Gõ /upgrade để xem chi tiết.";
  }

  return {
    found: true,
    tier,
    tier_name: tierName,
    email: boundLabel,
    status: revoked ? "Đã thu hồi" : "Đang hoạt động",
    message: `📋 [KẾT QUẢ TRA CỨU BẢN QUYỀN]\n• Hạng gói: ${tierName}\n• Tài khoản: ${boundLabel}\n• Trạng thái: ${revoked ? "⚠️ Đã thu hồi" : "✅ Hợp lệ"}${upsellNotice}`
  };
}

/**
 * Generate a VietQR image link. Returns "" when no receiving account is
 * configured, so a placeholder account can never be shown to a payer.
 * Transfer notes are reduced to A-Z/0-9/space (max 25 chars): many banks
 * strip or reject other characters such as "@".
 */
function generateVietQrUrl({
  amount = PAYMENT.upgradeProAmount,
  addInfo = "NANG CAP PRO",
  bankBin = PAYMENT.bankBin,
  accountNo = PAYMENT.accountNo,
  accountName = PAYMENT.accountName
} = {}) {
  if (!/^\d{6}$/.test(String(bankBin)) || !/^\d{6,19}$/.test(String(accountNo))) return "";
  const note = String(addInfo || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 25);
  const params = new URLSearchParams({ amount: String(Math.round(Number(amount) || 0)), addInfo: note });
  if (accountName) params.set("accountName", accountName);
  return `https://img.vietqr.io/image/${bankBin}-${accountNo}-compact2.png?${params.toString().replace(/\+/g, "%20")}`;
}

/**
 * Generate formatted Upsell Message
 */
function generateUpsellOffer({ email = "", currentTier = "standard" } = {}) {
  const qrUrl = generateVietQrUrl({ addInfo: "NANG CAP PRO" });
  const bankInfo = qrUrl
    ? `\n\n🏦 Thông tin chuyển khoản:\n• Ngân hàng: ${PAYMENT.bankName}\n• Số TK: ${PAYMENT.accountNo}\n• Chủ TK: ${PAYMENT.accountName}\n• Số tiền: ${PAYMENT.upgradeProAmount.toLocaleString("vi-VN")}đ\n• Nội dung: NANG CAP PRO + email tài khoản học\n\nChuyển khoản xong, bạn nhắn email + ảnh chụp giao dịch cho Ad để được nâng cấp ngay.`
    : "";

  return {
    title: "👑 ĐẶC QUYỀN NÂNG CẤP LÊN GÓI PRO AI LAB",
    current_tier: currentTier,
    upgrade_price: 200000,
    qr_url: qrUrl,
    text: `👑 [NÂNG CẤP GÓI PRO AI LAB - CHỈ BÙ 200.000đ]\n\nBạn đã sở hữu Gói Standard. Để nói tiếng Lào chuẩn thanh điệu như người Vientiane bản xứ, Phòng Luyện Nói AI Lab là công cụ đắc lực nhất:\n\n• 🌊 Biểu đồ sóng âm (Waveform): So sánh trực tiếp khẩu hình & độ cao giọng với người bản xứ.\n• 🎯 Chấm điểm % độ chuẩn xác thanh điệu (chuẩn 6 thanh tiếng Lào).\n• 🤖 Trợ lý AI đồng hành phân tích lỗi phát âm.\n\n💰 Chi phí nâng cấp: Chỉ bù đúng 200.000đ (Giá gốc: 499.000đ)!\n\n👉 Quét mã VietQR bên dưới để chuyển khoản, hoặc nhắn tin với Ad để được hỗ trợ.${bankInfo}`,
    reply_markup: {
      inline_keyboard: [
        ...(qrUrl ? [[{ text: "💳 Mở mã VietQR chuyển khoản 200k", url: qrUrl }]] : []),
        [
          { text: "🚀 Nâng Cấp Bù 200k (Zalo)", url: SUPPORT.zaloUrl }
        ],
        [
          { text: "📖 Xem Demo AI Lab", url: "https://tuhoctienglao.online/Slide-Tuong-Tac/" }
        ]
      ]
    }
  };
}

/**
 * Relay to the admin works only when both the admin's chat id and the bot
 * token are set (the relayed copy is an outbound Bot API call).
 */
function isAdminRelayEnabled() {
  return !!(getAdminChatId() && process.env.TELEGRAM_BOT_TOKEN);
}

function isAdmin(chatId, fromId) {
  const adminId = getAdminChatId();
  if (!adminId) return false;
  return String(chatId) === adminId || (fromId != null && String(fromId) === adminId);
}

const CONTACT_ADMIN_BUTTON = { text: "👤 Nhắn trực tiếp cho Ad", callback_data: "cmd_contact_admin" };

function contactAdminInfo(chatId) {
  const zaloRow = SUPPORT.zaloUrl ? [[{ text: `💬 Nhắn Zalo Ad (${SUPPORT.zaloPhone})`, url: SUPPORT.zaloUrl }]] : [];
  const text = isAdminRelayEnabled()
    ? `👤 [NHẮN TRỰC TIẾP CHO AD]\n\nGõ /ad kèm nội dung, ví dụ:\n/ad Mình đã chuyển khoản nâng cấp PRO, email abc@gmail.com\n\n📷 Ảnh chụp giao dịch: gửi thẳng ảnh vào đây, bot sẽ chuyển cho Ad.\n\nAd sẽ trả lời bạn ngay trong khung chat này.`
    : `👤 [LIÊN HỆ AD]\n\nBạn nhắn Zalo cho Ad${SUPPORT.zaloPhone ? ` qua số ${SUPPORT.zaloPhone}` : ""} để được hỗ trợ nhé.`;
  return { ok: true, chat_id: chatId, text, reply_markup: zaloRow.length ? { inline_keyboard: zaloRow } : undefined };
}

/**
 * Admin <-> learner relay. Returns a result, or null when the message is not
 * part of the relay and should go through the normal bot flow.
 */
function handleAdminRelay(message, text) {
  const chatId = message.chat ? message.chat.id : null;
  if (chatId == null) return null;
  const adminChatId = getAdminChatId();
  const isPrivate = !message.chat.type || message.chat.type === "private";

  // Admin replies to a relayed message -> deliver to the learner.
  if (adminChatId && String(chatId) === adminChatId && message.reply_to_message) {
    const r = message.reply_to_message;
    const tag = RELAY_TAG_RE.exec(String(r.text || "") + " " + String(r.caption || ""));
    if (!tag) return null;
    const userChatId = tag[1];
    const webhook = text
      ? { method: "sendMessage", chat_id: userChatId, text: `💬 Ad trả lời:\n\n${text}`.slice(0, 4096), disable_web_page_preview: true }
      : { method: "copyMessage", chat_id: userChatId, from_chat_id: chatId, message_id: message.message_id };
    return { ok: true, type: "admin_reply", user_chat_id: userChatId, webhook_reply: webhook };
  }

  if (!isPrivate || String(chatId) === adminChatId) return null;

  const isAdCommand = /^\/ad(@\w+)?(\s|$)/i.test(text);
  const isMedia = !text && !!(message.photo || message.document);
  if (!isAdCommand && !isMedia) return null;

  if (!isAdminRelayEnabled()) return contactAdminInfo(chatId);

  const content = isAdCommand ? text.replace(/^\/ad(@\w+)?/i, "").trim() : "";
  if (isAdCommand && !content) return contactAdminInfo(chatId);

  if (!allowRelay(chatId)) {
    return {
      ok: true,
      chat_id: chatId,
      text: `⏳ Bạn đã gửi khá nhiều tin cho Ad, vui lòng chờ Ad trả lời nhé.${SUPPORT.zaloUrl ? ` Việc gấp: Zalo ${SUPPORT.zaloPhone}.` : ""}`
    };
  }

  const sender = describeSender(message.from, chatId);
  const relay = isMedia
    ? {
        method: "copyMessage",
        payload: {
          chat_id: adminChatId,
          from_chat_id: chatId,
          message_id: message.message_id,
          caption: `📩 ${sender}\n${String(message.caption || "").slice(0, 800)}\n\n↩️ Trả lời (Reply) tin này để nhắn lại học viên.`.slice(0, 1024)
        }
      }
    : {
        method: "sendMessage",
        payload: {
          chat_id: adminChatId,
          text: `📩 ${sender}\n\n${content}\n\n↩️ Trả lời (Reply) tin này để nhắn lại học viên.`.slice(0, 4096),
          disable_web_page_preview: true
        }
      };
  return {
    ok: true,
    chat_id: chatId,
    type: "relay_to_admin",
    relay,
    text: isMedia ? "✅ Đã chuyển ảnh/tệp cho Ad. Ad sẽ trả lời bạn tại đây sớm nhất." : "✅ Đã gửi tin nhắn cho Ad. Ad sẽ trả lời bạn tại đây sớm nhất."
  };
}

/**
 * Handle incoming Telegram Webhook payloads (Messages & Callback Queries)
 */
function handleTelegramWebhook(body, store, courseData) {
  // 1. Handle Callback Query (Inline button clicks)
  if (body && body.callback_query) {
    const cb = body.callback_query;
    const data = String(cb.data || "");
    const cbChatId = cb.message && cb.message.chat ? cb.message.chat.id : null;

    // Quiz answers carry both the chosen and the correct option:
    // quiz_ans_<selected>_<correct> (stateless, fits Telegram's 64-byte limit).
    const quizMatch = /^quiz_ans_([0-3])_([0-3])$/.exec(data);
    if (quizMatch) {
      const letters = ["A", "B", "C", "D"];
      const selected = Number(quizMatch[1]);
      const correct = Number(quizMatch[2]);
      return {
        ok: true,
        type: "callback_answer",
        callback_query_id: cb.id,
        text:
          selected === correct
            ? `🎉 Chính xác! Đáp án ${letters[correct]}. Bạn phản xạ rất chuẩn!`
            : `💡 Chưa đúng rồi! Đáp án đúng là ${letters[correct]}. Bấm "Đổi câu hỏi khác" để thử tiếp nhé.`,
        show_alert: true
      };
    }

    // Menu buttons behave exactly like the matching text command.
    if (data === "cmd_contact_admin" && cbChatId != null) {
      return { ...contactAdminInfo(cbChatId), type: "callback_message", callback_query_id: cb.id };
    }

    // Admin action callbacks
    if (data.startsWith("admin_")) {
      const fromId = cb.from ? cb.from.id : null;
      if (!isAdmin(cbChatId, fromId)) {
        return {
          ok: true,
          type: "callback_answer",
          callback_query_id: cb.id,
          text: "⛔ Bạn không có quyền quản trị.",
          show_alert: true
        };
      }
      if (data === "admin_gen_std") {
        if (!store || typeof store.issueLicenses !== "function") {
          return { ok: true, type: "callback_answer", callback_query_id: cb.id, text: "⚠️ Store chưa hỗ trợ tạo mã.", show_alert: true };
        }
        const keys = store.issueLicenses({ tier: "standard", count: 1, note: "Admin Telegram" });
        const key = keys[0];
        return {
          ok: true,
          chat_id: cbChatId,
          type: "callback_message",
          callback_query_id: cb.id,
          text: `✅ [ĐÃ TẠO 1 KEY STANDARD]\n\n🎟️ Gói: Standard (299k)\n🔑 Mã kích hoạt: \`${key}\`\n\n💡 Chạm vào mã để copy gửi khách hàng.`,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🎟️ Tạo thêm Key Standard", callback_data: "admin_gen_std" }],
              [{ text: "👑 Tạo Key PRO VIP", callback_data: "admin_gen_pro" }],
              [{ text: "🔙 Menu Quản trị", callback_data: "admin_menu" }]
            ]
          }
        };
      }
      if (data === "admin_gen_pro") {
        if (!store || typeof store.issueLicenses !== "function") {
          return { ok: true, type: "callback_answer", callback_query_id: cb.id, text: "⚠️ Store chưa hỗ trợ tạo mã.", show_alert: true };
        }
        const keys = store.issueLicenses({ tier: "pro", count: 1, note: "Admin Telegram" });
        const key = keys[0];
        return {
          ok: true,
          chat_id: cbChatId,
          type: "callback_message",
          callback_query_id: cb.id,
          text: `✅ [ĐÃ TẠO 1 KEY PRO VIP]\n\n👑 Gói: PRO AI Lab (499k)\n🔑 Mã kích hoạt: \`${key}\`\n\n💡 Chạm vào mã để copy gửi khách hàng.`,
          reply_markup: {
            inline_keyboard: [
              [{ text: "👑 Tạo thêm Key PRO", callback_data: "admin_gen_pro" }],
              [{ text: "🎟️ Tạo Key Standard", callback_data: "admin_gen_std" }],
              [{ text: "🔙 Menu Quản trị", callback_data: "admin_menu" }]
            ]
          }
        };
      }
      if (data === "admin_stats") {
        const stats = store && typeof store.getLicenseStats === "function" ? store.getLicenseStats() : null;
        const msg = stats
          ? `📊 [THỐNG KÊ BẢN QUYỀN]\n• Tổng số mã: ${stats.total}\n• Gói Standard: ${stats.standard.total} (còn trống: ${stats.standard.unused})\n• Gói PRO VIP: ${stats.pro.total} (còn trống: ${stats.pro.unused})`
          : "📊 Chưa có số liệu thống kê bản quyền.";
        return {
          ok: true,
          chat_id: cbChatId,
          type: "callback_message",
          callback_query_id: cb.id,
          text: msg,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🎟️ Tạo Key Standard", callback_data: "admin_gen_std" }],
              [{ text: "👑 Tạo Key PRO VIP", callback_data: "admin_gen_pro" }],
              [{ text: "🔙 Menu Quản trị", callback_data: "admin_menu" }]
            ]
          }
        };
      }
      if (data === "admin_menu") {
        return {
          ok: true,
          chat_id: cbChatId,
          type: "callback_message",
          callback_query_id: cb.id,
          text: "🛠️ [MENU QUẢN TRỊ BẢN QUYỀN]\nChào Ad! Vui lòng chọn thao tác bên dưới:",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🎟️ Tạo 1 Key Standard (299k)", callback_data: "admin_gen_std" }],
              [{ text: "👑 Tạo 1 Key PRO VIP (499k)", callback_data: "admin_gen_pro" }],
              [{ text: "📊 Thống kê số lượng Key", callback_data: "admin_stats" }]
            ]
          }
        };
      }
    }

    // Buy flow buttons
    if (data === "cmd_buy" && cbChatId != null) {
      const reply = handleTelegramWebhook(
        { message: { text: "/buy", chat: { id: cbChatId } } },
        store,
        courseData
      );
      return { ...reply, type: "callback_message", callback_query_id: cb.id };
    }

    if ((data === "buy_standard" || data === "buy_pro") && cbChatId != null) {
      const isPro = data === "buy_pro";
      const tier = isPro ? "pro" : "standard";
      const tierName = isPro ? "👑 PRO VIP (Kèm AI Lab)" : "⭐ STANDARD (Tiêu chuẩn)";
      const amount = isPro ? 499000 : 299000;
      const orderCode = `LAO${isPro ? "PRO" : "STD"}${Math.floor(1000 + Math.random() * 9000)}`;
      const qrUrl = generateVietQrUrl({ amount, addInfo: orderCode });

      const text = `💳 [ĐẶT MUA GÓI ${tierName}]\n💰 Số tiền thanh toán: ${amount.toLocaleString("vi-VN")}đ\n\n🏦 THÔNG TIN CHUYỂN KHOẢN (VietQR):\n• Ngân hàng: ${PAYMENT.bankName}\n• Số TK: ${PAYMENT.accountNo}\n• Chủ TK: ${PAYMENT.accountName}\n• Số tiền: ${amount.toLocaleString("vi-VN")}đ\n• Nội dung CK: ${orderCode}\n\n👉 Quét mã QR qua link bên dưới hoặc chuyển khoản đúng nội dung trên.\nSau khi chuyển tiền xong, bạn bấm nút "Tôi đã chuyển khoản xong" bên dưới nhé!`;

      return {
        ok: true,
        chat_id: cbChatId,
        type: "callback_message",
        callback_query_id: cb.id,
        text,
        reply_markup: {
          inline_keyboard: [
            [{ text: "📸 Tôi đã chuyển khoản xong", callback_data: `paid_${orderCode}_${tier}_${amount}` }],
            ...(qrUrl ? [[{ text: "🖼️ Mở ảnh mã VietQR", url: qrUrl }]] : []),
            [CONTACT_ADMIN_BUTTON]
          ]
        }
      };
    }

    const paidMatch = /^paid_([A-Z0-9]+)_(standard|pro)_(\d+)$/.exec(data);
    if (paidMatch && cbChatId != null) {
      const orderCode = paidMatch[1];
      const tier = paidMatch[2];
      const amount = Number(paidMatch[3]);
      const tierName = tier === "pro" ? "PRO AI Lab (499k)" : "Standard (299k)";
      const senderDesc = describeSender(cb.from, cbChatId);

      const relay = getAdminChatId() ? {
        method: "sendMessage",
        payload: {
          chat_id: getAdminChatId(),
          text: `🔔 [ĐƠN HÀNG MỚI CHỜ DUYỆT]\n• Khách hàng: ${senderDesc}\n• Đơn hàng: ${orderCode}\n• Gói mua: ${tierName} (${amount.toLocaleString("vi-VN")}đ)\n• Nội dung CK cần kiểm tra: ${orderCode}\n\n👉 Mở app ${PAYMENT.bankName} kiểm tra. Nếu đã nhận tiền, bấm duyệt để cấp key:`,
          reply_markup: {
            inline_keyboard: [
              [{ text: `✅ Duyệt & Cấp Key ${tier.toUpperCase()}`, callback_data: `appr_${orderCode}_${tier}_${cbChatId}` }],
              [{ text: "❌ Hủy đơn", callback_data: `rej_${orderCode}_${cbChatId}` }]
            ]
          }
        }
      } : null;

      return {
        ok: true,
        chat_id: cbChatId,
        type: "callback_message",
        callback_query_id: cb.id,
        relay,
        text: `✅ [ĐÃ GHI NHẬN YÊU CẦU THANH TOÁN]\n\nCảm ơn bạn! Đơn hàng ${orderCode} (${tierName}) đã được chuyển đến Admin.\nAdmin đang kiểm tra giao dịch và sẽ duyệt cấp mã kích hoạt trực tiếp tại đây cho bạn trong vài phút nhé!`
      };
    }

    const apprMatch = /^appr_([A-Z0-9]+)_(standard|pro)_(-?\d+)$/.exec(data);
    if (apprMatch && cbChatId != null) {
      const fromId = cb.from ? cb.from.id : null;
      if (!isAdmin(cbChatId, fromId)) {
        return {
          ok: true,
          type: "callback_answer",
          callback_query_id: cb.id,
          text: "⛔ Bạn không có quyền duyệt đơn.",
          show_alert: true
        };
      }
      const orderCode = apprMatch[1];
      const tier = apprMatch[2];
      const customerChatId = apprMatch[3];
      const tierName = tier === "pro" ? "GÓI PRO AI LAB (499k)" : "GÓI STANDARD (299k)";

      let key = "ERROR_KEY";
      if (store && typeof store.issueLicenses === "function") {
        const keys = store.issueLicenses({ tier, count: 1, note: `Don ${orderCode} - TG ${customerChatId}` });
        key = keys[0];
      }

      const customerMessage = {
        method: "sendMessage",
        payload: {
          chat_id: customerChatId,
          text: `🎉 CHÚC MỪNG BẠN ĐÃ MỞ KHÓA THÀNH CÔNG!\nAdmin đã xác nhận thanh toán cho đơn hàng ${orderCode} (${tierName}).\n\n🔑 MÃ KÍCH HOẠT CỦA BẠN:\n\`${key}\`\n\n📖 HƯỚNG DẪN KÍCH HOẠT:\n1. Mở ứng dụng PWA: https://tuhoctienglao.online/Slide-Tuong-Tac/\n2. Bấm "🔑 Đăng nhập / Kích hoạt"\n3. Nhập Email, Mật khẩu của bạn và dán Mã kích hoạt ở trên vào.\n4. Bấm "Kích hoạt" để mở khóa toàn bộ bài học trọn đời!\n\nChúc bạn học tiếng Lào thật hào hứng và hiệu quả! 🇱🇦`
        }
      };

      return {
        ok: true,
        chat_id: cbChatId,
        type: "callback_message",
        callback_query_id: cb.id,
        extra_dispatches: [customerMessage],
        text: `✅ [ĐÃ DUYỆT ĐƠN HÀNG ${orderCode}]\n\nĐã cấp mã ${tier.toUpperCase()} cho học viên #u${customerChatId}:\n\`${key}\`\n\nHệ thống đã tự động gửi mã và hướng dẫn kích hoạt vào chat của khách!`
      };
    }

    const rejMatch = /^rej_([A-Z0-9]+)_(-?\d+)$/.exec(data);
    if (rejMatch && cbChatId != null) {
      const fromId = cb.from ? cb.from.id : null;
      if (!isAdmin(cbChatId, fromId)) {
        return {
          ok: true,
          type: "callback_answer",
          callback_query_id: cb.id,
          text: "⛔ Bạn không có quyền thao tác.",
          show_alert: true
        };
      }
      const orderCode = rejMatch[1];
      const customerChatId = rejMatch[2];

      const customerMessage = {
        method: "sendMessage",
        payload: {
          chat_id: customerChatId,
          text: `⚠️ [THÔNG BÁO GIAO DỊCH]\nAdmin kiểm tra chưa thấy khoản tiền chuyển cho đơn hàng ${orderCode}.\nNếu bạn đã chuyển khoản, vui lòng gửi ảnh chụp sao kê hoặc nhắn /ad <nội dung> để Admin kiểm tra và hỗ trợ ngay nhé!`
        }
      };

      return {
        ok: true,
        chat_id: cbChatId,
        type: "callback_message",
        callback_query_id: cb.id,
        extra_dispatches: [customerMessage],
        text: `❌ [ĐÃ TỪ CHỐI ĐƠN HÀNG ${orderCode}]\nĐã gửi thông báo kiểm tra lại cho khách #u${customerChatId}.`
      };
    }

    const commandForButton = { cmd_quiz: "/quiz", cmd_upgrade: "/upgrade", cmd_faq: "/faq", cmd_buy: "/buy" }[data];
    if (commandForButton && cbChatId != null) {
      const reply = handleTelegramWebhook(
        { message: { text: commandForButton, chat: { id: cbChatId } } },
        store,
        courseData
      );
      return { ...reply, type: "callback_message", callback_query_id: cb.id };
    }

    return { ok: true, type: "callback_answer", callback_query_id: cb.id, text: "", show_alert: false };
  }

  // 2. Handle Text Messages
  const message = body && body.message;
  const edited = body && body.edited_message;
  if (message) {
    const relayResult = handleAdminRelay(message, String(message.text || "").trim());
    if (relayResult) return relayResult;
  }
  const msg = message || edited;
  if (!msg || !msg.text) {
    return { ok: true, text: "Không nhận diện được nội dung tin nhắn." };
  }

  const text = msg.text.trim();
  const lower = text.toLowerCase();
  const chatId = msg.chat ? msg.chat.id : null;

  // /myid: lets the admin find the chat id for TELEGRAM_ADMIN_CHAT_ID
  if (/^\/myid(@\w+)?$/i.test(text)) {
    return { ok: true, chat_id: chatId, text: `🆔 Chat ID của bạn: ${chatId}` };
  }

  // Telegram Inline Keyboards for Main Menu
  const mainKeyboard = {
    inline_keyboard: [
      [
        { text: "📖 Học thử PWA (Web)", url: "https://tuhoctienglao.online/Slide-Tuong-Tac/" },
        { text: "💳 Mua Khóa Học (VietQR)", callback_data: "cmd_buy" }
      ],
      [
        { text: "🎯 Mini-Quiz 1 Phút", callback_data: "cmd_quiz" },
        { text: "🚀 Nâng Cấp PRO (Bù 200k)", callback_data: "cmd_upgrade" }
      ],
      [
        { text: "❓ Hỏi đáp FAQ", callback_data: "cmd_faq" },
        CONTACT_ADMIN_BUTTON
      ],
      ...(SUPPORT.zaloUrl ? [[{ text: `💬 Zalo Ad (${SUPPORT.zaloPhone})`, url: SUPPORT.zaloUrl }]] : [])
    ]
  };

  // /admin
  if (lower === "/admin" || lower.startsWith("/admin ")) {
    const fromId = msg.from ? msg.from.id : null;
    if (!isAdmin(chatId, fromId)) {
      return {
        ok: true,
        chat_id: chatId,
        text: "⛔ Lệnh này chỉ dành cho Quản trị viên (Admin)."
      };
    }
    return {
      ok: true,
      chat_id: chatId,
      text: "🛠️ [MENU QUẢN TRỊ BẢN QUYỀN]\nChào Ad! Vui lòng chọn thao tác bên dưới:",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎟️ Tạo 1 Key Standard (299k)", callback_data: "admin_gen_std" }],
          [{ text: "👑 Tạo 1 Key PRO VIP (499k)", callback_data: "admin_gen_pro" }],
          [{ text: "📊 Thống kê số lượng Key", callback_data: "admin_stats" }]
        ]
      }
    };
  }

  // /buy or /mua
  if (lower.startsWith("/buy") || lower.startsWith("/mua") || lower === "mua" || lower.includes("mua khóa học") || lower.includes("mua gói")) {
    return {
      ok: true,
      chat_id: chatId,
      text: `🇱🇦 [ĐĂNG KÝ BẢN QUYỀN KHÓA HỌC]\n\nChào bạn! Khóa học gồm 2 gói bản quyền trọn đời:\n• ⭐ GÓI STANDARD (299.000đ): Trọn bộ 8 chương, 840 audio bản xứ, PWA offline, đồng bộ 3 máy.\n• 👑 GÓI PRO AI LAB (499.000đ): Toàn bộ quyền lợi Standard + Phòng Lab phát âm AI (so sánh sóng âm waveform, chấm điểm thanh điệu) + Bot 1-1.\n\n👉 Bấm chọn gói bên dưới để nhận mã VietQR thanh toán tự động:`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎟️ Mua Gói Standard (299.000đ)", callback_data: "buy_standard" }],
          [{ text: "👑 Mua Gói PRO VIP (499.000đ)", callback_data: "buy_pro" }],
          [{ text: "🚀 Nâng Cấp Lên PRO (Bù 200k)", callback_data: "cmd_upgrade" }],
          [CONTACT_ADMIN_BUTTON]
        ]
      }
    };
  }

  // /start or /help
  if (lower.startsWith("/start") || lower.startsWith("/help")) {
    const fromId = msg.from ? msg.from.id : null;
    const adminHint = isAdmin(chatId, fromId) ? "\n• 🛠️ /admin - Menu quản trị viên cấp mã" : "";
    return {
      ok: true,
      chat_id: chatId,
      text: `👋 Chào bạn! Tôi là Bot Trợ Giảng Tự Học Tiếng Lào.\n\nTôi có thể giúp bạn:\n• 💳 /buy - Đặt mua khóa học Standard / Pro qua VietQR\n• ❓ /faq - Hỏi đáp FAQ & tư vấn khóa học\n• ⏰ /remind - Nhắc lịch học 15 phút hôm nay\n• 🎯 /quiz - Mini-quiz 1 phút kiểm tra từ vựng\n• 🚀 /upgrade - Nhận ưu đãi nâng cấp PRO AI Lab (bù 200k)\n• 🔍 /check <mã_kích_hoạt> - Tra cứu trạng thái bản quyền\n• 📜 /policy - Xem cam kết bảo vệ dữ liệu (Nghị định 13/2023/NĐ-CP)\n• 👤 /ad <nội dung> - Nhắn trực tiếp cho Ad${adminHint}\n\nHãy chọn nhanh tính năng bên dưới hoặc nhắn tin cho tôi nhé!`,
      reply_markup: mainKeyboard
    };
  }

  // /remind
  if (lower.startsWith("/remind") || lower.includes("nhắc học") || lower.includes("lịch học")) {
    const rem = getDailyReminder();
    return {
      ok: true,
      chat_id: chatId,
      text: rem.message,
      reply_markup: {
        inline_keyboard: [
          [{ text: "📖 Mở App Luyện 15 Phút Ngay", url: "https://tuhoctienglao.online/Slide-Tuong-Tac/" }]
        ]
      }
    };
  }

  // /quiz
  if (lower.startsWith("/quiz") || lower.includes("làm quiz") || lower.includes("câu đố")) {
    const quiz = generateMicroQuiz(courseData);
    const letters = ["A", "B", "C", "D"];
    const quizButtons = letters.map((letter, idx) => ({
      text: letter,
      callback_data: `quiz_ans_${idx}_${quiz.answer}`
    }));

    return {
      ok: true,
      chat_id: chatId,
      quiz,
      text: `🎯 [MINI-QUIZ 1 PHÚT]\n${quiz.q}\n\n${quiz.options.join("\n")}\n\n💡 Bấm chọn đáp án bên dưới:`,
      reply_markup: {
        inline_keyboard: [
          quizButtons,
          [{ text: "🔄 Đổi câu hỏi khác", callback_data: "cmd_quiz" }]
        ]
      }
    };
  }

  // /faq: list the knowledge base questions
  if (lower.startsWith("/faq")) {
    const list = FAQ_DATABASE.map((f, i) => `${i + 1}. ${f.question}`).join("\n");
    return {
      ok: true,
      chat_id: chatId,
      text: `❓ [CÂU HỎI THƯỜNG GẶP]\n${list}\n\n👉 Bạn chỉ cần nhắn câu hỏi bằng lời của mình (ví dụ: "giá bao nhiêu", "học offline được không"), bot sẽ trả lời ngay.`
    };
  }

  // /upgrade or upsell query
  if (lower.startsWith("/upgrade") || lower.includes("nâng cấp") || lower.includes("lên pro") || lower.includes("bù 200")) {
    const upsell = generateUpsellOffer();
    return {
      ok: true,
      chat_id: chatId,
      text: upsell.text,
      reply_markup: { inline_keyboard: [...upsell.reply_markup.inline_keyboard, [CONTACT_ADMIN_BUTTON]] }
    };
  }

  // /check or /license
  if (lower.startsWith("/check") || lower.startsWith("/license")) {
    const parts = text.split(/\s+/);
    const q = parts.slice(1).join(" ");
    const info = checkLicenseInfo(q, store);
    const buttons = [];
    if (info.found && info.tier === "standard") {
      buttons.push([{ text: "👑 Nâng cấp lên PRO AI Lab (Bù 200k)", url: SUPPORT.zaloUrl }]);
    }
    return {
      ok: true,
      chat_id: chatId,
      text: info.message,
      reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
    };
  }

  // /policy
  if (lower.startsWith("/policy") || lower.includes("chính sách") || lower.includes("bảo mật") || lower.includes("nghị định 13")) {
    const faq = FAQ_DATABASE.find(f => f.id === "faq_policy");
    return {
      ok: true,
      chat_id: chatId,
      text: `📜 [CHÍNH SÁCH BẢO MẬT & NGHỊ ĐỊNH 13/2023/NĐ-CP]\n${faq.answer}\n\nXem chi tiết tại: https://tuhoctienglao.online/Slide-Tuong-Tac/`
    };
  }

  // FAQ Knowledge base lookup
  const matched = matchFaq(text);
  if (matched) {
    return {
      ok: true,
      chat_id: chatId,
      faq_id: matched.id,
      text: `💡 [GIẢI ĐÁP FAQ]\n❓ ${matched.question}\n\n${matched.answer}`,
      reply_markup: matched.id === "faq_pricing" ? {
        inline_keyboard: [
          [{ text: "🎟️ Mua Gói Standard 299k (VietQR)", callback_data: "buy_standard" }],
          [{ text: "👑 Mua Gói PRO VIP 499k (VietQR)", callback_data: "buy_pro" }],
          ...(SUPPORT.zaloUrl ? [[{ text: `💬 Nhắn Zalo Ad (${SUPPORT.zaloPhone})`, url: SUPPORT.zaloUrl }]] : [])
        ]
      } : undefined
    };
  }

  // Fallback response
  return {
    ok: true,
    chat_id: chatId,
    text: `Cảm ơn bạn đã nhắn tin! Tôi đã ghi nhận câu hỏi: "${text}".\n\nBạn có thể gõ:\n• "giá" hoặc "gói" để xem bảng giá 2 gói Standard & Pro.\n• /upgrade để nhận ưu đãi nâng cấp PRO AI Lab (bù 200k).\n• "cách học" để tìm hiểu phương pháp Pimsleur 15 phút.\n• /quiz để làm câu hỏi nhỏ ôn bài.\n• /ad <nội dung> để nhắn trực tiếp cho Ad.\n• Hoặc nhắn trực tiếp với đội ngũ hỗ trợ qua Zalo ${SUPPORT.zaloPhone}: ${SUPPORT.zaloUrl}`,
    reply_markup: mainKeyboard
  };
}

/**
 * Convert a handleTelegramWebhook() result into a Telegram webhook reply.
 * Telegram executes the Bot API method named in `method` when the webhook
 * response is JSON, so no outbound call (and no bot token) is needed to reply.
 * Returns null when there is nothing to send.
 */
function toTelegramWebhookReply(result) {
  if (!result) return null;
  if (result.webhook_reply) return result.webhook_reply;
  if (result.type === "callback_answer") {
    if (!result.callback_query_id) return null;
    return {
      method: "answerCallbackQuery",
      callback_query_id: result.callback_query_id,
      text: String(result.text || "").slice(0, 200),
      show_alert: !!result.show_alert
    };
  }
  if (result.chat_id == null || !result.text) return null;
  const reply = {
    method: "sendMessage",
    chat_id: result.chat_id,
    text: String(result.text).slice(0, 4096),
    disable_web_page_preview: true
  };
  if (result.reply_markup) reply.reply_markup = result.reply_markup;
  return reply;
}

/**
 * Handle incoming Zalo Webhook payloads
 */
function handleZaloWebhook(body, store, courseData) {
  const eventName = body && body.event_name;
  const msgText = (body && body.message && body.message.text) || (typeof body === "string" ? body : "");

  // Follow event (New user starts following Zalo OA)
  if (eventName === "follow") {
    return {
      error: 0,
      message: "Success",
      reply: "🇱🇦 Sabaidee! Chào mừng bạn đã theo dõi Tự Học Tiếng Lào!\n\n🎁 Tặng bạn Sổ tay 100 câu tiếng Lào sinh tồn bỏ túi & Học thử miễn phí Chương 1:\n👉 Vào học ngay tại: https://tuhoctienglao.online/Slide-Tuong-Tac/\n\nNếu cần tư vấn khóa học hoặc đăng ký gói Standard/Pro, hãy nhắn ngay cho Ad nhé!"
    };
  }

  if (!msgText) {
    return { error: 0, message: "No text message in payload" };
  }

  const tgRes = handleTelegramWebhook({ message: { text: msgText } }, store, courseData);
  return {
    error: 0,
    message: "Success",
    reply: tgRes.text,
    quiz: tgRes.quiz || null
  };
}

/**
 * Dispatch outbound message to Telegram API
 */
function dispatchTelegramOutbound(token, method, payload) {
  return new Promise((resolve, reject) => {
    if (!token) return resolve({ ok: false, error: "No TELEGRAM_BOT_TOKEN set" });

    const data = JSON.stringify(payload);
    const req = https.request(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data)
        },
        timeout: 8000
      },
      (res) => {
        let body = "";
        res.on("data", chunk => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            resolve({ ok: res.statusCode === 200, body });
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Telegram API request timed out"));
    });

    req.write(data);
    req.end();
  });
}

module.exports = {
  FAQ_DATABASE,
  DAILY_REMINDERS,
  matchFaq,
  getDailyReminder,
  generateMicroQuiz,
  checkLicenseInfo,
  generateVietQrUrl,
  generateUpsellOffer,
  handleTelegramWebhook,
  toTelegramWebhookReply,
  handleZaloWebhook,
  dispatchTelegramOutbound
};
