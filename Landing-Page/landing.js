/**
 * Landing page behaviour. Loaded as an external file so it runs under the
 * server's CSP (`script-src 'self'`): no inline <script> or on*= handlers.
 */
(function () {
  "use strict";

  const LANDING_POLICIES = {
    terms: `
      <h4>1. Phạm vi &amp; Quyền sở hữu trí tuệ</h4>
      <p>Toàn bộ nội dung khóa học "Tự Học Nghe – Nói Tiếng Lào Cho Người Việt" (bao gồm 8 chương, 27 bài học, 840 thẻ audio người bản xứ, hệ thống video shadowing, bài kiểm tra) thuộc quyền sở hữu trí tuệ độc quyền của ban phát triển dự án. Nghiêm cấm mọi hành vi trích xuất, sao chép hoặc phân phối lại vì mục đích thương mại.</p>
      <h4>2. Quy định Mã Bản Quyền (License Key)</h4>
      <p>Mỗi mã kích hoạt được gắn cố định với 01 địa chỉ email của học viên và được sử dụng đồng bộ trên tối đa 03 thiết bị cá nhân. Hệ thống tự động khóa các mã bản quyền bị chia sẻ công khai trái phép.</p>
      <h4>3. Phân tầng Gói dịch vụ</h4>
      <p><strong>Gói Standard:</strong> Mở toàn bộ 8 chương học, audio bản xứ, tính năng tự ghi âm đối chiếu cơ bản.</p>
      <p><strong>Gói Pro AI Lab:</strong> Toàn quyền Standard + Phòng Luyện Nói AI (so sánh sóng âm, chấm điểm % độ chuẩn xác thanh điệu) và kết nối Bot học tập 1-1.</p>
    `,
    privacy: `
      <h4>1. Tuân thủ Nghị định 13/2023/NĐ-CP</h4>
      <p>Chúng tôi cam kết bảo vệ dữ liệu cá nhân của người học theo đúng Nghị định 13/2023/NĐ-CP của Chính phủ Việt Nam.</p>
      <h4>2. Dữ liệu thu thập &amp; Mục đích</h4>
      <p>Dữ liệu chỉ bao gồm: Email (định danh tài khoản), Mật khẩu (mã hóa scrypt bảo mật), Tiến trình học tập và Bản ghi âm do học viên tự thực hiện.</p>
      <p>Mục đích duy nhất: Xác thực quyền học tập, đồng bộ tiến độ qua các thiết bị và phân tích phát âm cá nhân.</p>
      <p>Khi bạn đăng ký nhận tài liệu miễn phí (và tích ô đồng ý), chúng tôi lưu thêm Họ tên, Email và Số điện thoại/Zalo để gửi tài liệu, bài học và thông tin khóa học. Bạn có thể hủy nhận email bất cứ lúc nào qua liên kết "hủy đăng ký" ở cuối mỗi email.</p>
      <h4>3. Cam kết Bảo Mật &amp; Quyền người dùng</h4>
      <p>Tuyệt đối <strong>KHÔNG</strong> bán hoặc chia sẻ thông tin học viên cho bên thứ ba. Học viên có quyền trích xuất hoặc yêu cầu xóa vĩnh viễn dữ liệu tài khoản bất cứ lúc nào.</p>
    `,
    audio: `
      <h4>1. Bảo vệ dữ liệu giọng nói học viên</h4>
      <p>Bản ghi âm giọng nói của bạn được xử lý an toàn nhằm mục đích so sánh sóng âm và chấm điểm phát âm cho cá nhân bạn.</p>
      <h4>2. Quyền riêng tư tuyệt đối</h4>
      <p>Chúng tôi không công khai bản thu của bạn và không sử dụng dữ liệu giọng nói để huấn luyện mô hình AI thương mại công cộng nếu chưa có sự đồng ý riêng.</p>
    `
  };

  // ---- Policy modal ----
  const modal = document.getElementById("landingPolicyModal");
  let lastFocus = null;

  function switchPolicyTab(tab) {
    const key = LANDING_POLICIES[tab] ? tab : "terms";
    document.querySelectorAll("[data-policy-tab]").forEach((btn) => {
      const active = btn.dataset.policyTab === key;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    // Static, trusted content defined above (never user input).
    document.getElementById("landingPolicyBody").innerHTML = LANDING_POLICIES[key];
  }

  function openPolicy(tab) {
    if (!modal) return;
    lastFocus = document.activeElement;
    switchPolicyTab(tab);
    modal.classList.remove("hidden");
    const closeBtn = modal.querySelector(".landing-modal-close");
    if (closeBtn) closeBtn.focus();
  }

  function closePolicy() {
    if (!modal || modal.classList.contains("hidden")) return;
    modal.classList.add("hidden");
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  document.querySelectorAll("[data-policy-open]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      openPolicy(link.dataset.policyOpen);
    });
  });
  document.querySelectorAll("[data-policy-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchPolicyTab(btn.dataset.policyTab));
  });
  document.querySelectorAll("[data-policy-close]").forEach((btn) => {
    btn.addEventListener("click", closePolicy);
  });
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closePolicy();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePolicy();
  });

  // Make div-based controls usable from the keyboard (Enter / Space).
  function onActivate(el, handler) {
    if (!el) return;
    el.addEventListener("click", handler);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler.call(el, e);
      }
    });
  }

  // ---- Demo flashcard ----
  const demoCard = document.getElementById("demoCard");
  let isFlipped = false;
  onActivate(demoCard, () => {
    const reveal = document.getElementById("demoReveal");
    const hint = document.getElementById("demoCardHint");
    isFlipped = !isFlipped;
    demoCard.setAttribute("aria-pressed", String(isFlipped));
    if (isFlipped) {
      reveal.style.opacity = "1";
      reveal.style.transform = "scale(1.02)";
      hint.innerHTML = "✅ Phát âm chuẩn: <strong>Xa-bai-đi! Chạu xa-bai-đi bò?</strong> (Bấm để úp lại)";
    } else {
      reveal.style.opacity = "0.4";
      reveal.style.transform = "scale(1)";
      hint.textContent = "👉 Bấm vào thẻ để xem đáp án phát âm";
    }
  });

  // ---- FAQ accordion ----
  document.querySelectorAll(".faq-question").forEach((q) => {
    onActivate(q, () => {
      const item = q.parentElement;
      const wasActive = item.classList.contains("active");
      document.querySelectorAll(".faq-item").forEach((i) => {
        i.classList.remove("active");
        const btn = i.querySelector(".faq-question");
        if (btn) btn.setAttribute("aria-expanded", "false");
      });
      if (!wasActive) {
        item.classList.add("active");
        q.setAttribute("aria-expanded", "true");
      }
    });
  });

  // ---- Lead capture form ----
  const form = document.getElementById("leadCaptureForm");
  const SUBMIT_LABEL = "🚀 Nhận Sổ Tay & Mở Khóa Học Thử Ngay";

  function showMessage(kind, build) {
    const msg = document.getElementById("leadFormMsg");
    msg.replaceChildren();
    msg.style.display = "block";
    msg.style.background = kind === "ok" ? "#dcfce7" : "#fee2e2";
    msg.style.color = kind === "ok" ? "#15803d" : "#b91c1c";
    build(msg);
  }

  function el(tag, text, attrs) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  }

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const btn = document.getElementById("btnSubmitLead");
      const name = document.getElementById("leadName").value.trim();
      const phone = document.getElementById("leadPhone").value.trim();
      const email = document.getElementById("leadEmail").value.trim().toLowerCase();
      const consent = document.getElementById("leadConsent").checked;

      btn.disabled = true;
      btn.textContent = "⏳ Đang gửi tài liệu...";
      document.getElementById("leadFormMsg").style.display = "none";

      try {
        const res = await fetch("/api/bot/leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, phone, email, source: "landing_page_ebook", consent }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          // User input is only ever inserted as text, never as HTML.
          showMessage("ok", (msg) => {
            msg.append("🎉 ", el("strong", "Thành công!"), " Đã gửi email kèm Sổ Tay & Link Chương 1 tới ", el("strong", email), ".");
            msg.append(el("br"), "Hãy kiểm tra Hộp thư đến (hoặc mục Spam/Quảng cáo).", el("br"));
            const link = el("a", "👉 Vào học thử Chương 1 ngay lập tức", { href: "./Slide-Tuong-Tac/" });
            link.style.cssText = "color:#0284c7;font-weight:bold;text-decoration:underline;display:inline-block;margin-top:8px;";
            msg.append(link);
          });
          form.reset();
        } else {
          showMessage("error", (msg) => {
            msg.textContent = "⚠️ " + (data.error || "Có lỗi xảy ra, vui lòng thử lại.");
          });
        }
      } catch (_) {
        showMessage("error", (msg) => {
          msg.textContent = "⚠️ Không thể kết nối máy chủ. Vui lòng nhắn tin trực tiếp với Trợ Giảng qua Zalo!";
        });
      } finally {
        btn.disabled = false;
        btn.textContent = SUBMIT_LABEL;
      }
    });
  }
})();
