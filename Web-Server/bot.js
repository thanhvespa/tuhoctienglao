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
const https = require("https");

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
 * Generate VietQR quick link for upgrade / purchase
 */
function generateVietQrUrl({ amount = 200000, addInfo = "NANG CAP PRO", bankBin = "970422", accountNo = "0123456789" }) {
  const encodedInfo = encodeURIComponent(addInfo);
  return `https://img.vietqr.io/image/${bankBin}-${accountNo}-compact2.png?amount=${amount}&addInfo=${encodedInfo}`;
}

/**
 * Generate formatted Upsell Message
 */
function generateUpsellOffer({ email = "", currentTier = "standard" } = {}) {
  const qrUrl = generateVietQrUrl({
    amount: 200000,
    addInfo: `UPGRADE PRO ${email || "USER"}`.trim()
  });

  return {
    title: "👑 ĐẶC QUYỀN NÂNG CẤP LÊN GÓI PRO AI LAB",
    current_tier: currentTier,
    upgrade_price: 200000,
    qr_url: qrUrl,
    text: `👑 [NÂNG CẤP GÓI PRO AI LAB - CHỈ BÙ 200.000đ]\n\nBạn đã sở hữu Gói Standard. Để nói tiếng Lào chuẩn thanh điệu như người Vientiane bản xứ, Phòng Luyện Nói AI Lab là công cụ đắc lực nhất:\n\n• 🌊 Biểu đồ sóng âm (Waveform): So sánh trực tiếp khẩu hình & độ cao giọng với người bản xứ.\n• 🎯 Chấm điểm % độ chuẩn xác thanh điệu (chuẩn 6 thanh tiếng Lào).\n• 🤖 Trợ lý AI đồng hành phân tích lỗi phát âm.\n\n💰 Chi phí nâng cấp: Chỉ bù đúng 200.000đ (Giá gốc: 499.000đ)!\n\n👉 Chuyển khoản VietQR hoặc nhắn tin với Ad để kích hoạt ngay: https://zalo.me/tuhoctienglao?text=Toi%20muon%20nang%20cap%20PRO%20AI%20Lab%20bu%20200k`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🚀 Nâng Cấp Bù 200k (Zalo)", url: "https://zalo.me/tuhoctienglao?text=Toi%20muon%20nang%20cap%20PRO%20AI%20Lab%20bu%20200k" }
        ],
        [
          { text: "📖 Xem Demo AI Lab", url: "https://tuhoctienglao.online/Slide-Tuong-Tac/" }
        ]
      ]
    }
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
    const commandForButton = { cmd_quiz: "/quiz", cmd_upgrade: "/upgrade", cmd_faq: "/faq" }[data];
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
  const message = body && (body.message || body.edited_message);
  if (!message || !message.text) {
    return { ok: true, text: "Không nhận diện được nội dung tin nhắn." };
  }

  const text = message.text.trim();
  const lower = text.toLowerCase();
  const chatId = message.chat ? message.chat.id : null;

  // Telegram Inline Keyboards for Main Menu
  const mainKeyboard = {
    inline_keyboard: [
      [
        { text: "📖 Học thử PWA (Web)", url: "https://tuhoctienglao.online/Slide-Tuong-Tac/" },
        { text: "🎯 Mini-Quiz 1 Phút", callback_data: "cmd_quiz" }
      ],
      [
        { text: "🚀 Nâng Cấp PRO (Bù 200k)", callback_data: "cmd_upgrade" },
        { text: "❓ Hỏi đáp FAQ", callback_data: "cmd_faq" }
      ],
      [
        { text: "💬 Trợ Giảng Zalo (24/7)", url: "https://zalo.me/tuhoctienglao" }
      ]
    ]
  };

  // /start or /help
  if (lower.startsWith("/start") || lower.startsWith("/help")) {
    return {
      ok: true,
      chat_id: chatId,
      text: `👋 Chào bạn! Tôi là Bot Trợ Giảng Tự Học Tiếng Lào.\n\nTôi có thể giúp bạn:\n• ❓ Hỏi đáp FAQ & tư vấn khóa học\n• ⏰ /remind - Nhắc lịch học 15 phút hôm nay\n• 🎯 /quiz - Mini-quiz 1 phút kiểm tra từ vựng\n• 🚀 /upgrade - Nhận ưu đãi nâng cấp PRO AI Lab (bù 200k)\n• 🔍 /check <mã_kích_hoạt> - Tra cứu trạng thái bản quyền\n• 📜 /policy - Xem cam kết bảo vệ dữ liệu (Nghị định 13/2023/NĐ-CP)\n\nHãy chọn nhanh tính năng bên dưới hoặc nhắn tin cho tôi nhé!`,
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
      reply_markup: upsell.reply_markup
    };
  }

  // /check or /license
  if (lower.startsWith("/check") || lower.startsWith("/license")) {
    const parts = text.split(/\s+/);
    const q = parts.slice(1).join(" ");
    const info = checkLicenseInfo(q, store);
    const buttons = [];
    if (info.found && info.tier === "standard") {
      buttons.push([{ text: "👑 Nâng cấp lên PRO AI Lab (Bù 200k)", url: "https://zalo.me/tuhoctienglao?text=Toi%20muon%20nang%20cap%20PRO%20bu%20200k" }]);
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
          [{ text: "🎟️ Mua Gói Standard 299k", url: "https://zalo.me/tuhoctienglao?text=Mua%20Standard%20299k" }],
          [{ text: "👑 Mua Gói PRO AI Lab 499k", url: "https://zalo.me/tuhoctienglao?text=Mua%20PRO%20499k" }]
        ]
      } : undefined
    };
  }

  // Fallback response
  return {
    ok: true,
    chat_id: chatId,
    text: `Cảm ơn bạn đã nhắn tin! Tôi đã ghi nhận câu hỏi: "${text}".\n\nBạn có thể gõ:\n• "giá" hoặc "gói" để xem bảng giá 2 gói Standard & Pro.\n• /upgrade để nhận ưu đãi nâng cấp PRO AI Lab (bù 200k).\n• "cách học" để tìm hiểu phương pháp Pimsleur 15 phút.\n• /quiz để làm câu hỏi nhỏ ôn bài.\n• Hoặc nhắn trực tiếp với đội ngũ hỗ trợ qua Zalo: https://zalo.me/tuhoctienglao`,
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
