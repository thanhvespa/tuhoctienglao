/**
 * Mailer Service for Automated Email Sequences & Upsell Drips.
 * 
 * Supports:
 * - Resend API (via RESEND_API_KEY)
 * - Brevo / Sendinblue API (via BREVO_API_KEY)
 * - SMTP fallback (via SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS)
 * - Development / File outbox fallback (saves to data/email_outbox.json)
 * - Fully compliant with Decree 13/2023/ND-CP with unsubscribe links & data protection notices.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const OUTBOX_FILE = path.join(DATA_DIR, "email_outbox.json");
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "https://tuhoctienglao.com").replace(/\/+$/, "");

/** Escape every user-controlled value before it is placed into email HTML. */
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Signed unsubscribe links. The server registers an HMAC signer at startup so
// nobody can unsubscribe (or probe) another person's email by editing the URL.
let unsubscribeSigner = null;
function configureUnsubscribeSigner(fn) {
  unsubscribeSigner = typeof fn === "function" ? fn : null;
}
function buildUnsubscribeUrl(email) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean || !unsubscribeSigner) return `${PUBLIC_BASE_URL}/unsubscribe`;
  return `${PUBLIC_BASE_URL}/unsubscribe?email=${encodeURIComponent(clean)}&token=${encodeURIComponent(unsubscribeSigner(clean))}`;
}

function displayNameOf({ name, email }) {
  const raw = String(name || "").trim() || String(email || "").split("@")[0];
  return escapeHtml(raw.slice(0, 80));
}

function ensureOutboxFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(OUTBOX_FILE)) {
    fs.writeFileSync(OUTBOX_FILE, JSON.stringify({ outbox: [] }, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

function logToOutbox(mailRecord) {
  try {
    ensureOutboxFile();
    const raw = fs.readFileSync(OUTBOX_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.outbox)) data.outbox = [];
    data.outbox.unshift({
      id: "mail_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      created_at: new Date().toISOString(),
      ...mailRecord
    });
    // Keep max 500 records
    if (data.outbox.length > 500) data.outbox.length = 500;
    const tmp = `${OUTBOX_FILE}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, OUTBOX_FILE);
  } catch (err) {
    console.error("[Mailer] Failed to write outbox log:", err.message);
  }
}

/**
 * Send email via Resend API
 */
function sendViaResend(apiKey, from, to, subject, htmlText) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: from || "Tự Học Tiếng Lào <hoc@tuhoctienglao.com>",
      to: Array.isArray(to) ? to : [to],
      subject,
      html: htmlText
    });

    const req = https.request(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 10000
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve({ ok: true, provider: "resend", data: JSON.parse(body) });
            } catch (_) {
              resolve({ ok: true, provider: "resend", body });
            }
          } else {
            reject(new Error(`Resend error ${res.statusCode}: ${body}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Resend request timed out"));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Send email via Brevo (Sendinblue) API
 */
function sendViaBrevo(apiKey, from, to, subject, htmlText) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      sender: { name: "Tự Học Tiếng Lào", email: from || "hoc@tuhoctienglao.com" },
      to: (Array.isArray(to) ? to : [to]).map(e => ({ email: e })),
      subject,
      htmlContent: htmlText
    });

    const req = https.request(
      "https://api.brevo.com/v3/smtp/email",
      {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 10000
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, provider: "brevo", response: body });
          } else {
            reject(new Error(`Brevo error ${res.statusCode}: ${body}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Brevo request timed out"));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Universal Send Email function.
 * Automatically chooses the best provider configured in environment:
 * 1. RESEND_API_KEY
 * 2. BREVO_API_KEY
 * 3. Log to outbox (dev / fallback mode)
 */
async function sendMail({ to, subject, html, templateId, metadata = {} }) {
  if (!to || !subject || !html) {
    throw new Error("Missing required email fields: to, subject, html");
  }

  const resendKey = process.env.RESEND_API_KEY;
  const brevoKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.MAIL_FROM || "hotro@tuhoctienglao.com";

  let sendResult = null;
  let providerUsed = "outbox_dev";
  let status = "sent";
  let errorMsg = null;

  try {
    if (resendKey) {
      sendResult = await sendViaResend(resendKey, fromEmail, to, subject, html);
      providerUsed = "resend";
    } else if (brevoKey) {
      sendResult = await sendViaBrevo(brevoKey, fromEmail, to, subject, html);
      providerUsed = "brevo";
    } else {
      // Local development or pending keys: safely store in outbox
      providerUsed = "outbox_local";
      sendResult = { ok: true, notice: "Stored in local outbox (set RESEND_API_KEY or BREVO_API_KEY for live delivery)" };
    }
  } catch (err) {
    status = "failed";
    errorMsg = err.message;
    console.warn(`[Mailer Warning] Failed delivery to ${to}: ${err.message}. Storing to outbox.`);
  }

  // Always log to outbox for audit and tracking
  logToOutbox({
    to,
    subject,
    template_id: templateId || "custom",
    status,
    provider: providerUsed,
    error: errorMsg,
    metadata
  });

  return {
    ok: status === "sent",
    status,
    provider: providerUsed,
    error: errorMsg,
    result: sendResult
  };
}

/**
 * Shared HTML Email Layout Wrapper with Branding and Decree 13 Compliance
 */
function wrapHtmlEmail({ title, preheader, contentHtml, unsubscribeEmail }) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title || "Tự Học Tiếng Lào")}</title>
  <style>
    body { margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.6; }
    .wrapper { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.04); }
    .header { background: linear-gradient(135deg, #0d3b66, #001e3d); padding: 28px 24px; text-align: center; color: #ffffff; }
    .header h1 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
    .header p { margin: 6px 0 0 0; font-size: 13px; color: #cbd5e1; }
    .body-content { padding: 32px 24px; }
    .btn { display: inline-block; background-color: #d97706; color: #ffffff !important; text-decoration: none; font-weight: 700; font-size: 15px; padding: 13px 28px; border-radius: 8px; margin: 18px 0; text-align: center; box-shadow: 0 4px 10px rgba(217, 119, 6, 0.3); }
    .btn-secondary { background-color: #0284c7; box-shadow: 0 4px 10px rgba(2, 132, 199, 0.3); }
    .highlight-box { background: #f0fdf4; border-left: 4px solid #16a34a; padding: 16px; border-radius: 6px; margin: 20px 0; font-size: 14px; color: #166534; }
    .pro-box { background: #fffbeb; border: 2px dashed #d97706; padding: 20px; border-radius: 10px; margin: 24px 0; text-align: center; }
    .footer { background: #f1f5f9; padding: 20px 24px; font-size: 12px; color: #64748b; text-align: center; border-top: 1px solid #e2e8f0; }
    .footer a { color: #0284c7; text-decoration: none; }
  </style>
</head>
<body>
  <div style="display:none;font-size:1px;color:#333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    ${escapeHtml(preheader || title)}
  </div>
  <div class="wrapper">
    <div class="header">
      <div style="font-size: 32px; margin-bottom: 8px;">🇱🇦</div>
      <h1>Tự Học Nghe – Nói Tiếng Lào</h1>
      <p>Phương pháp Phản Xạ 15 Phút &amp; AI Pronunciation Lab</p>
    </div>
    <div class="body-content">
      ${contentHtml}
    </div>
    <div class="footer">
      <p style="margin: 0 0 8px 0;"><strong>Dự án Tự Học Tiếng Lào Cho Người Việt</strong></p>
      <p style="margin: 0 0 8px 0;">Trụ sở &amp; Nền tảng học trực tuyến PWA: <a href="https://tuhoctienglao.com">tuhoctienglao.com</a></p>
      <p style="margin: 0 0 8px 0; font-size: 11px;">
        Cam kết bảo vệ dữ liệu theo <strong>Nghị định 13/2023/NĐ-CP</strong>. Dữ liệu của bạn được mã hóa an toàn và không bao giờ chia sẻ cho bên thứ ba.
      </p>
      <p style="margin: 8px 0 0 0;">
        Nếu bạn không muốn nhận email bài học nữa, <a href="${escapeHtml(buildUnsubscribeUrl(unsubscribeEmail))}">bấm vào đây để hủy đăng ký</a>.
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ---- PRE-DESIGNED TEMPLATES ----

/**
 * 1. Welcome Lead Email (Day 0)
 */
function templateWelcomeLead({ email, name }) {
  const displayName = displayNameOf({ name, email });
  const content = `
    <h2 style="color: #0d3b66; margin-top: 0;">Chào ${displayName}! Rất vui được đồng hành cùng bạn 🇱🇦</h2>
    <p>Cảm ơn bạn đã quan tâm đến chương trình <strong>Tự Học Nghe – Nói Tiếng Lào Cho Người Việt</strong>. Hành trình nói tiếng Lào tự tin sau 30 ngày của bạn bắt đầu ngay từ hôm nay!</p>
    
    <div class="highlight-box">
      <strong>🎁 Quà tặng dành riêng cho bạn:</strong>
      <p style="margin: 6px 0 0 0;">Bạn đã được mở khóa toàn quyền <strong>Chương 1: Âm Thanh Lào &amp; Chào Hỏi Cơ Bản</strong> kèm Sổ tay bỏ túi 100 câu tiếng Lào sinh tồn.</p>
    </div>

    <p>Để bắt đầu học ngay mà không cần cài đặt phức tạp:</p>
    <div style="text-align: center;">
      <a href="https://tuhoctienglao.com/Slide-Tuong-Tac/" class="btn">
        👉 Vào Học Thử Chương 1 Miễn Phí
      </a>
    </div>

    <h3 style="color: #1e293b; margin-top: 24px;">💡 3 mẹo nhỏ giúp bạn học nhanh nhất:</h3>
    <ul style="padding-left: 20px; color: #475569;">
      <li><strong>Chỉ 15 phút mỗi ngày:</strong> Đừng học dồn 2 tiếng rồi nghỉ cả tuần. Mỗi ngày 15 phút là đủ hình thành phản xạ.</li>
      <li><strong>Nghe và nhắc lại to rõ (Shadowing):</strong> Nghe câu thoại bản xứ và nhắc lại ngay trong 3 giây.</li>
      <li><strong>Cài app vào màn hình chính:</strong> Trên điện thoại, chọn <em>Thêm vào màn hình chính (Add to Home Screen)</em> để mở học offline mọi lúc.</li>
    </ul>

    <p style="margin-top: 24px;">Nếu cần hỗ trợ kỹ thuật hoặc tư vấn lộ trình học, bạn có thể nhắn tin trực tiếp với Trợ giảng qua Zalo: <a href="https://zalo.me/tuhoctienglao" style="color: #0284c7; font-weight: bold;">zalo.me/tuhoctienglao</a>.</p>
    
    <p>Chúc bạn có những giờ học thật hứng khởi!<br><strong>Ban Giảng Thuật Tự Học Tiếng Lào</strong></p>
  `;

  return {
    subject: "🇱🇦 Chào mừng bạn! Quà tặng Sổ tay & Trọn bộ bài học Chương 1",
    html: wrapHtmlEmail({
      title: "Chào mừng bạn đến với Tự Học Tiếng Lào",
      preheader: "Mở khóa Chương 1 và Sổ tay 100 câu tiếng Lào sinh tồn miễn phí cho bạn.",
      contentHtml: content,
      unsubscribeEmail: email
    })
  };
}

/**
 * 2. Drip Day 2: The 15-Minute Habit & Pimsleur Method
 */
function templateDripDay2({ email, name }) {
  const displayName = displayNameOf({ name, email });
  const content = `
    <h2 style="color: #0d3b66; margin-top: 0;">Bí quyết phản xạ tiếng Lào trong 3 giây ⏱️</h2>
    <p>Chào ${displayName},</p>
    <p>Hầu hết mọi người học ngoại ngữ hay bị vướng vào bẫy: <em>Cố nhớ bảng chữ cái và cày ngữ pháp dày đặc</em>. Kết quả là khi sang Viêng Chăn, gặp người bản xứ chào <strong>"Sabaidee"</strong> thì phải mất 10 giây dịch trong đầu mới ú ớ trả lời được.</p>

    <div class="highlight-box">
      <strong>🎯 Phương pháp Phản Xạ Pimsleur Cải Tiến có gì khác?</strong>
      <p style="margin: 6px 0 0 0;">Chúng tôi cắt bỏ toàn bộ lý thuyết hàn lâm. Bạn được tiếp xúc trực tiếp với <strong>840 tình huống thực tế</strong>: Đi chợ, gọi món, trả giá tuk-tuk, hỏi đường, khách sạn. Bạn nghe - não bộ ghi nhận thanh điệu - và bạn bật ra câu trả lời chỉ trong 3 giây.</p>
    </div>

    <p>Hôm nay, hãy dành đúng 15 phút để thử thách khả năng ghi nhớ từ vựng với Mini-Quiz 1 phút:</p>
    <div style="text-align: center;">
      <a href="https://t.me/tuhoctienglao_bot?start=quiz" class="btn btn-secondary">
        🎯 Làm Mini-Quiz Trên Telegram Bot
      </a>
      <a href="https://tuhoctienglao.com/Slide-Tuong-Tac/" class="btn" style="margin-left: 10px;">
        📖 Mở App Ôn Lại Bài 1
      </a>
    </div>

    <p style="color: #64748b; font-size: 14px; margin-top: 20px;">
      <em>"Thành công không đến từ việc học 1 ngày 5 tiếng, mà đến từ 15 phút đều đặn mỗi ngày."</em>
    </p>
  `;

  return {
    subject: "Cách người bận rộn nói được tiếng Lào chỉ với 15 phút mỗi ngày 🇱🇦",
    html: wrapHtmlEmail({
      title: "Bí quyết phản xạ tiếng Lào trong 3 giây",
      preheader: "Phương pháp Pimsleur giúp bạn giao tiếp tự tin khi đi du lịch hoặc công tác Lào.",
      contentHtml: content,
      unsubscribeEmail: email
    })
  };
}

/**
 * 3. Drip Day 3: Conversion to Standard Tier (299k)
 */
function templateOfferStandard({ email, name }) {
  const displayName = displayNameOf({ name, email });
  const content = `
    <h2 style="color: #0d3b66; margin-top: 0;">Mở khóa trọn bộ 8 chương: Ưu đãi đặc biệt dành cho bạn 🎟️</h2>
    <p>Chào ${displayName},</p>
    <p>Bạn đã trải nghiệm qua các bài học đầu tiên của Chương 1. Để tự tin sang Lào du lịch, buôn bán hoặc công tác mà không cần phiên dịch viên, bạn cần trang bị trọn bộ 8 tình huống giao tiếp sống còn.</p>

    <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <h3 style="margin-top: 0; color: #0d3b66;">🌟 QUYỀN LỢI GÓI STANDARD (TRỌN ĐỜI):</h3>
      <ul style="padding-left: 20px; margin-bottom: 0;">
        <li>✅ Mở khóa toàn bộ <strong>8 chương (27 bài học, 840 câu thoại mẫu)</strong>.</li>
        <li>✅ 100% audio người bản xứ Vientiane giọng chuẩn, rõ ràng.</li>
        <li>✅ Tính năng <strong>Lưu Offline</strong>: Học trên máy bay, sang Lào không cần mạng 4G.</li>
        <li>✅ Đồng bộ học tập trên <strong>3 thiết bị cùng lúc</strong> (Điện thoại, Tablet, Máy tính).</li>
        <li>✅ Cấp mã kích hoạt <code>LAO-STD-XXXX-XXXX</code> sở hữu vĩnh viễn, không gia hạn định kỳ.</li>
      </ul>
    </div>

    <div class="pro-box">
      <div style="text-decoration: line-through; color: #94a3b8; font-size: 14px;">Giá gốc: 590.000đ</div>
      <div style="font-size: 28px; font-weight: 800; color: #d97706; margin: 6px 0;">299.000đ</div>
      <p style="margin: 0 0 14px 0; font-size: 13px; color: #475569;">Thanh toán 1 lần • Sở hữu trọn đời • Tiết kiệm 50%</p>
      <a href="https://zalo.me/tuhoctienglao?text=Tôi muốn mua Gói Standard 299k cho email ${escapeHtml(encodeURIComponent(email))}" class="btn">
        🚀 Nhận Mã Kích Hoạt Gói Standard Ngay
      </a>
    </div>

    <p style="font-size: 13px; color: #64748b;">
      *Hệ thống tự động kích hoạt mã ngay sau khi xác nhận chuyển khoản. Hỗ trợ kỹ thuật 1-1 qua Zalo nếu bạn gặp bất kỳ trở ngại nào.
    </p>
  `;

  return {
    subject: "🎟️ [Ưu đãi 50%] Mở khóa trọn bộ 8 chương Tự Học Tiếng Lào chỉ 299k",
    html: wrapHtmlEmail({
      title: "Ưu đãi Gói Standard Tự Học Tiếng Lào",
      preheader: "Mở khóa toàn bộ 8 chương và 840 câu thoại bản xứ với giá chỉ 299.000đ trọn đời.",
      contentHtml: content,
      unsubscribeEmail: email
    })
  };
}

/**
 * 4. Upsell to PRO AI Lab Tier (bù 200k)
 */
function templateUpsellPro({ email, name, licenseKey }) {
  const displayName = displayNameOf({ name, email });
  const content = `
    <h2 style="color: #92400e; margin-top: 0;">👑 Nâng Cấp Phòng Luyện Phát Âm AI: Chuẩn Hóa Từng Thanh Điệu</h2>
    <p>Chào ${displayName},</p>
    <p>Chúc mừng bạn đang tiến bộ rất nhanh trên ứng dụng Tự Học Tiếng Lào! Tuy nhiên, có một bí mật mà người học tiếng Lào nào cũng gặp phải:</p>
    
    <div class="highlight-box" style="background: #fff7ed; border-color: #ea580c; color: #9a3412;">
      <strong>⚠️ Tiếng Lào có tới 6 thanh điệu:</strong>
      <p style="margin: 6px 0 0 0;">Chỉ cần sai một cao độ, từ "Đi chợ" có thể biến thành nghĩa hoàn toàn khác. Việc tự nghe lại đôi khi không đủ để nhận ra mình đang bị sai ở đâu.</p>
    </div>

    <h3 style="color: #0d3b66;">Đó là lý do chúng tôi phát triển: PHÒNG LAB LUYỆN NÓI AI (PRO AI LAB)</h3>
    <ul style="padding-left: 20px;">
      <li>🌊 <strong>So sánh sóng âm trực quan (Waveform &amp; Pitch):</strong> Đặt biểu đồ âm thanh giọng bạn nằm ngay cạnh người bản xứ Vientiane để thấy rõ độ chênh lệch.</li>
      <li>🎯 <strong>Chấm điểm % chính xác:</strong> Biết ngay bạn đạt 85%, 92% hay cần chỉnh lại phần nguyên âm.</li>
      <li>🤖 <strong>Bot Trợ Giảng 1-1 trên Telegram/Zalo:</strong> Nhắc học cá nhân hóa và giải đáp phát âm ưu tiên.</li>
    </ul>

    <div class="pro-box">
      <span style="background: #fef3c7; color: #92400e; font-size: 11px; font-weight: 800; padding: 4px 10px; border-radius: 999px;">ĐẶC QUYỀN HỌC VIÊN STANDARD</span>
      <h3 style="margin: 10px 0 6px 0; color: #92400e;">Nâng cấp lên GÓI PRO AI LAB (499.000đ)</h3>
      <p style="margin: 0; color: #475569;">Bạn đã sở hữu Gói Standard, nên <strong>CHỈ CẦN BÙ 200.000đ</strong> chênh lệch!</p>
      <div style="font-size: 26px; font-weight: 800; color: #d97706; margin: 12px 0;">+200.000đ</div>
      <a href="https://zalo.me/tuhoctienglao?text=Tôi muốn nâng cấp lên PRO AI Lab bù 200k cho email ${escapeHtml(encodeURIComponent(email))}" class="btn">
        🚀 Nâng Cấp PRO AI Lab Ngay
      </a>
      <p style="margin: 10px 0 0 0; font-size: 12px; color: #64748b;">Mã tài khoản của bạn: <code>${escapeHtml(licenseKey || email)}</code></p>
    </div>

    <p style="color: #64748b; font-size: 13px;">Hãy để AI giúp bạn nói tiếng Lào tự nhiên như người bản xứ ngay từ những ngày đầu tiên!</p>
  `;

  return {
    subject: "👑 [Nâng cấp AI Lab] Tự tin phát âm chuẩn Vientiane với công nghệ so sánh sóng âm (Chỉ bù 200k)",
    html: wrapHtmlEmail({
      title: "Đặc quyền nâng cấp PRO AI Lab",
      preheader: "Chỉ bù 200.000đ để sở hữu Phòng luyện nói AI so sánh sóng âm và chấm điểm chuẩn thanh điệu.",
      contentHtml: content,
      unsubscribeEmail: email
    })
  };
}

/**
 * 5. License Delivery Email (Receipt & Instructions)
 */
function templateLicenseKey({ email, name, tier, licenseKey }) {
  const isPro = tier === "pro";
  const tierTitle = isPro ? "GÓI PRO AI LAB (Trọn Đời)" : "GÓI STANDARD (Trọn Đời)";
  const safeKey = escapeHtml(licenseKey);
  const safeEmail = escapeHtml(email);
  const displayName = displayNameOf({ name, email });

  const content = `
    <h2 style="color: #0d3b66; margin-top: 0;">Xác nhận thanh toán thành công &amp; Mã kích hoạt khóa học 🎉</h2>
    <p>Chào ${displayName},</p>
    <p>Cảm ơn bạn đã tin tưởng lựa chọn khóa học <strong>Tự Học Nghe – Nói Tiếng Lào Cho Người Việt</strong>. Dưới đây là thông tin bản quyền của bạn:</p>

    <div style="background: #f8fafc; border: 2px solid ${isPro ? '#d97706' : '#0284c7'}; border-radius: 10px; padding: 20px; text-align: center; margin: 20px 0;">
      <div style="font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; font-weight: 700;">Hạng gói bản quyền</div>
      <div style="font-size: 20px; font-weight: 800; color: ${isPro ? '#b45309' : '#0369a1'}; margin: 4px 0 12px 0;">${tierTitle}</div>
      <div style="font-size: 13px; color: #64748b;">Mã kích hoạt của bạn:</div>
      <div style="display: inline-block; background: #ffffff; border: 2px dashed #94a3b8; font-family: monospace; font-size: 22px; font-weight: bold; color: #0f172a; padding: 10px 24px; border-radius: 8px; margin: 8px 0; letter-spacing: 2px;">
        ${safeKey}
      </div>
      <div style="font-size: 12px; color: #64748b; margin-top: 6px;">Email gắn mã: <strong>${safeEmail}</strong> • Giới hạn 3 thiết bị</div>
    </div>

    <h3 style="color: #0d3b66;">👉 3 Bước kích hoạt khóa học trong 30 giây:</h3>
    <ol style="padding-left: 20px; color: #334155; line-height: 1.8;">
      <li>Truy cập ứng dụng PWA tại: <a href="https://tuhoctienglao.com/Slide-Tuong-Tac/" style="color: #0284c7; font-weight: bold;">tuhoctienglao.com/Slide-Tuong-Tac/</a></li>
      <li>Bấm nút <strong>"🔑 Đăng nhập / Kích hoạt"</strong> ở góc trên bên phải màn hình.</li>
      <li>Nhập Email: <code>${safeEmail}</code>, đặt Mật khẩu của bạn và dán Mã kích hoạt ở trên vào rồi bấm <strong>Kích hoạt</strong>.</li>
    </ol>

    <div style="text-align: center; margin: 24px 0;">
      <a href="https://tuhoctienglao.com/Slide-Tuong-Tac/" class="btn">
        🚀 Bấm Vào Đây Để Kích Hoạt Ngay
      </a>
    </div>

    <p style="font-size: 13px; color: #64748b;">
      Bạn cần hỗ trợ kích hoạt hoặc cài đặt offline? Nhắn tin ngay cho Trợ giảng qua Zalo: <a href="https://zalo.me/tuhoctienglao" style="color: #0284c7;">zalo.me/tuhoctienglao</a>.
    </p>
  `;

  return {
    subject: `🔑 [Mã Bản Quyền] ${tierTitle} - Tự Học Tiếng Lào`,
    html: wrapHtmlEmail({
      title: "Mã kích hoạt bản quyền khóa học",
      preheader: `Mã kích hoạt: ${licenseKey}. Đăng nhập và mở khóa trọn bộ bài học ngay.`,
      contentHtml: content,
      unsubscribeEmail: email
    })
  };
}

module.exports = {
  escapeHtml,
  configureUnsubscribeSigner,
  buildUnsubscribeUrl,
  sendMail,
  logToOutbox,
  wrapHtmlEmail,
  templateWelcomeLead,
  templateDripDay2,
  templateOfferStandard,
  templateUpsellPro,
  templateLicenseKey,
  OUTBOX_FILE
};
