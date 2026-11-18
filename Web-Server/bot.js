/**
 * Bot Service for Telegram & Zalo integrations.
 * Zero-dependency, pure Node.js module providing:
 * - Knowledge base FAQ matching (Course, Pricing, Policies, Decree 13/2023/ND-CP).
 * - Daily 15-minute study reminders by chapter.
 * - 1-minute vocabulary/dialogue micro-quizzes.
 * - License key & account tier lookup (Standard vs Pro).
 * - Webhook handlers for Telegram Bot API & Zalo OA events.
 */

"use strict";

const crypto = require("crypto");

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
    id: "faq_license",
    keywords: ["mã", "kích hoạt", "license", "key", "nhập mã", "cách kích hoạt", "đăng ký"],
    question: "Cách kích hoạt mã khóa học như thế nào?",
    answer: "Sau khi thanh toán, bạn sẽ nhận được mã dạng LAO-STD-XXXX-XXXX (Standard) hoặc LAO-PRO-XXXX-XXXX (Pro). Bạn chỉ cần truy cập app tại https://tuhoctienglao.com/Slide-Tuong-Tac/, bấm '🔑 Đăng nhập / Kích hoạt', điền Email, Mật khẩu và Mã kích hoạt để mở khóa ngay lập tức."
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
    message: `⏰ [NHẮC LỊCH HỌC 15 PHÚT HÔM NAY]\n📖 ${item.title}\n🎯 Mục tiêu: ${item.goal}\n👉 Mở app luyện ngay: https://tuhoctienglao.com/Slide-Tuong-Tac/`
  };
}

function generateMicroQuiz(courseData) {
  // If no course data passed, fallback to standard curated quiz pool
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

  // Pick random vocab item from chapters
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

  // Pick 3 distractors
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

function checkLicenseInfo(query, store) {
  if (!query || !store) return { found: false, error: "Vui lòng nhập mã kích hoạt hoặc email để tra cứu." };
  const cleanQ = query.trim().toUpperCase().replace(/[^A-Z0-9@._-]/g, "");

  // Check in licenses array
  const licenses = store.licenses || [];
  const matchedLic = licenses.find(l => {
    if (!l.hint) return false;
    const parts = l.hint.split("-****-");
    if (parts.length === 2) {
      const [pfx, sfx] = parts;
      return cleanQ.startsWith(pfx) && cleanQ.endsWith(sfx);
    }
    const rawHint = l.hint.replace(/[* -]/g, "");
    const rawQ = cleanQ.replace(/[-]/g, "");
    return rawQ.includes(rawHint);
  });

  // Check in users array
  const users = store.users || [];
  let matchedUser = users.find(u => u.email && u.email.toUpperCase() === cleanQ);
  if (!matchedUser && matchedLic) {
    matchedUser = users.find(u => u.license_id === matchedLic.id);
  }

  if (!matchedLic && !matchedUser) {
    return {
      found: false,
      message: `Không tìm thấy thông tin bản quyền cho "${query}". Hãy kiểm tra lại mã LAO-STD-XXXX-XXXX / LAO-PRO-XXXX-XXXX hoặc Email đã đăng ký.`
    };
  }

  const tier = (matchedUser && matchedUser.tier) || (matchedLic && matchedLic.tier) || "standard";
  const tierName = tier === "pro" ? "👑 GÓI PRO VIP (Kèm AI Lab)" : "⭐ GÓI STANDARD (Tiêu chuẩn)";

  return {
    found: true,
    tier,
    tier_name: tierName,
    email: matchedUser ? matchedUser.email : "Chưa gắn tài khoản (Mã mới phát hành)",
    devices: matchedUser ? `${(matchedUser.devices || []).length} / ${matchedUser.max_devices || 3}` : "0 / 3",
    status: (matchedLic && matchedLic.revoked) ? "Đã thu hồi" : "Đang hoạt động",
    message: `📋 [KẾT QUẢ TRA CỨU BẢN QUYỀN]\n• Hạng gói: ${tierName}\n• Email: ${matchedUser ? matchedUser.email : "Mã sẵn sàng kích hoạt"}\n• Thiết bị: ${matchedUser ? (matchedUser.devices || []).length : 0}/3\n• Trạng thái: ${(matchedLic && matchedLic.revoked) ? "⚠️ Đã thu hồi" : "✅ Hợp lệ"}`
  };
}

function handleTelegramWebhook(body, store, courseData) {
  const message = body && (body.message || body.edited_message);
  if (!message || !message.text) {
    return { ok: true, text: "Không nhận diện được nội dung tin nhắn." };
  }

  const text = message.text.trim();
  const lower = text.toLowerCase();

  // Command handling
  if (lower.startsWith("/start") || lower.startsWith("/help")) {
    return {
      ok: true,
      text: `👋 Chào bạn! Tôi là Bot Trợ Giảng Tự Học Tiếng Lào.\n\nTôi có thể giúp bạn:\n• ❓ Hỏi đáp FAQ & tư vấn khóa học\n• ⏰ /remind - Nhắc lịch học 15 phút hôm nay\n• 🎯 /quiz - Mini-quiz 1 phút kiểm tra từ vựng\n• 🔍 /check <mã_hoặc_email> - Tra cứu trạng thái bản quyền\n• 📜 /policy - Xem cam kết bảo vệ dữ liệu (Nghị định 13/2023/NĐ-CP)\n\nBạn muốn tìm hiểu thông tin gì? Hãy nhắn tin cho tôi nhé!`
    };
  }

  if (lower.startsWith("/remind") || lower.includes("nhắc học") || lower.includes("lịch học")) {
    const rem = getDailyReminder();
    return { ok: true, text: rem.message };
  }

  if (lower.startsWith("/quiz") || lower.includes("làm quiz") || lower.includes("câu đố")) {
    const quiz = generateMicroQuiz(courseData);
    return {
      ok: true,
      quiz,
      text: `🎯 [MINI-QUIZ 1 PHÚT]\n${quiz.q}\n\n${quiz.options.join("\n")}\n\n💡 Bấm chọn đáp án hoặc gõ A, B, C, D để xem lời giải!`
    };
  }

  if (lower.startsWith("/check") || lower.startsWith("/license")) {
    const parts = text.split(/\s+/);
    const q = parts.slice(1).join(" ");
    const info = checkLicenseInfo(q, store);
    return { ok: true, text: info.message };
  }

  if (lower.startsWith("/policy") || lower.includes("chính sách") || lower.includes("bảo mật")) {
    const faq = FAQ_DATABASE.find(f => f.id === "faq_policy");
    return { ok: true, text: `📜 [CHÍNH SÁCH BẢO MẬT & NGHỊ ĐỊNH 13/2023/NĐ-CP]\n${faq.answer}\n\nXem chi tiết tại: https://tuhoctienglao.com/Slide-Tuong-Tac/` };
  }

  // FAQ Knowledge base lookup
  const matched = matchFaq(text);
  if (matched) {
    return {
      ok: true,
      faq_id: matched.id,
      text: `💡 [GIẢI ĐÁP FAQ]\n❓ ${matched.question}\n\n${matched.answer}`
    };
  }

  // Default fallback response
  return {
    ok: true,
    text: `Cảm ơn bạn đã nhắn tin! Tôi đã ghi nhận câu hỏi: "${text}".\n\nBạn có thể gõ:\n• "giá" hoặc "gói" để xem bảng giá 2 gói Standard & Pro.\n• "cách học" để tìm hiểu phương pháp Pimsleur 15 phút.\n• /quiz để làm câu hỏi nhỏ ôn bài.\n• Hoặc nhắn trực tiếp với đội ngũ hỗ trợ qua Zalo: https://zalo.me/tuhoctienglao`
  };
}

function handleZaloWebhook(body, store, courseData) {
  // Zalo OA webhook schema: event_name: "user_send_text_message", message: { text: ... }
  const eventName = body && body.event_name;
  const msgText = (body && body.message && body.message.text) || (typeof body === "string" ? body : "");

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

module.exports = {
  FAQ_DATABASE,
  DAILY_REMINDERS,
  matchFaq,
  getDailyReminder,
  generateMicroQuiz,
  checkLicenseInfo,
  handleTelegramWebhook,
  handleZaloWebhook,
};
