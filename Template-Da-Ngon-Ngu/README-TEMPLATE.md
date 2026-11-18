# Template Khóa Học Đa Ngôn Ngữ (Multi-Language Course Factory)

Thư mục này được sinh tự động từ dự án **Tự Học Nghe – Nói** để bạn nhân bản nhanh sang các ngôn ngữ khác (`th` Thái, `km` Khmer, `my` Myanmar, `ko` Hàn, `ja` Nhật, `zh` Trung, `id` Indonesia...).

## Cấu trúc cốt lõi

- `course.config.json`: Cấu hình toàn bộ ngôn ngữ, regex tách chữ, giọng Edge TTS, font OFL, EPUB metadata, PWA branding & Video canvas.
- `Giao-Trinh/Chuong-XX-.../Bai-XX-....md`: Các bài học Markdown chuẩn (`## 1.`, `## 2.` bảng từ vựng, `## 3.` mẫu câu `→`, `## 4.` hội thoại `Vai`, `## 5.` thực hành).
- `Giao-Trinh/Chuong-XX-.../Kiem-Tra-Chuong-XX.md`: Bài kiểm tra chuẩn (`Phần A..D` + `# Đáp Án`) để PWA tự chấm trắc nghiệm/điền đáp án.
- `tools/build_study_assets.py`: Biên dịch Markdown -> `Slide-Tuong-Tac/curriculum_data.{json,js}`, `manifest.webmanifest`, PWA icons & gói `Export-NotebookLM-Gamma/`.
- `tools/build_epub.py`: Đóng gói EPUB 3 + TOC NCX + nhúng font hợp pháp OFL vào `Ebook/`.
- `tools/build_web_dist.py` + `Web-Server/server.js` + `tools/license_cli.py`: Tách bản học thử/trả phí vào `dist-web/` và chạy web server bảo mật kiểm tra đăng nhập & mã kích hoạt.
- `Cong-Cu-Tao-Audio-Video/`: Tạo hàng loạt MP3 giọng bản địa (Edge Neural TTS), track M4A & video flashcard `.mp4` (hỗ trợ cả `--portrait` 9:16).
- `tools/init_course.py`: CLI sinh nhanh thư mục khóa học ngôn ngữ mới.

## Quy trình 4 bước để ra mắt khóa ngôn ngữ mới

1. **Khởi tạo ngôn ngữ mong muốn** (nếu muốn tạo bộ khung cho ngôn ngữ khác preset `generic`):
   ```bash
   python3 tools/init_course.py --lang th --out ../Tu-Hoc-Tieng-Thai
   ```
   Các preset có sẵn: `generic, th, km, my, ko, ja, zh, id`.
2. **Cài font chữ hợp pháp (nếu là chữ tượng hình/phi-Latin):**
   - Copy font hợp pháp (SIL Open Font License `OFL.txt` + `.ttf`) vào `assets/fonts/` và `Slide-Tuong-Tac/fonts/` trùng khớp đường dẫn trong `course.config.json` (`tự chọn trên fonts.google.com`).
   - Tải miễn phí tại [fonts.google.com/noto](https://fonts.google.com/noto) (giấy phép SIL OFL 1.1 cho phép bán thương mại).
3. **Viết hoặc dùng AI sinh nội dung `Giao-Trinh/` đúng chuẩn Markdown.**
4. **Biên dịch toàn bộ sản phẩm số & đóng gói Web bán hàng:**
   ```bash
   python3 tools/build_study_assets.py
   python3 tools/build_epub.py
   bash Cong-Cu-Tao-Audio-Video/setup_and_generate.sh all
   python3 tools/build_web_dist.py
   ```
5. **Sinh mã kích hoạt & chạy Web Server online:**
   ```bash
   python3 tools/license_cli.py generate --count 5
   node Web-Server/server.js
   # Mở trình duyệt tại: http://127.0.0.1:8787/Slide-Tuong-Tac/
   ```
