# Bộ Công Cụ Tạo Audio MP3 & Video Clip MP4 Tự Động

Công cụ đọc cấu hình từ `course.config.json` và toàn bộ giáo trình trong `Giao-Trinh/` để tự động tạo ra bộ media đa nền tảng:

1. **Audio `.mp3` giọng bản địa (Microsoft Edge Neural TTS):**
   - Giọng nữ & giọng nam bản địa được cấu hình trong `course.config.json` (`tts.female_voice`, `tts.male_voice`).
   - Giọng tiếng Việt đọc gợi ý phản xạ: giọng offline macOS `Linh` (hoặc Edge Neural `vi-VN-HoaiMyNeural` nếu chạy ngoài macOS).
   - Sau khi chạy, **PWA Slide Tương Tác (`Slide-Tuong-Tac/index.html`)** tự động phát file `.mp3` cục bộ hoặc lưu **Cache Offline**.
2. **Video Flashcard Phản Xạ `.mp4` (trong `Media-Video/`):**
   - Không cần cài `ffmpeg` — sử dụng trình dựng video Swift gốc trên macOS (`render_video.swift`, `AVFoundation` + `CoreText`).
   - Nạp trực tiếp file font hợp pháp (OFL/Apache) khai báo ở `course.config.json` (`fonts.bold` / `fonts.regular`, ví dụ `NotoSansLao-Bold.ttf`).
   - Hỗ trợ cả **khổ ngang 16:9 (1280×720)** mặc định và **khổ dọc 9:16 (1080×1920)** cho YouTube Shorts / TikTok / Reels.
   - Cấu trúc mỗi thẻ trong video: **Hiện tiếng Việt + đọc gợi ý → Dừng ~2 giây để người học tự nói thử → Hiện chữ gốc cỡ lớn + Phiên âm + phát giọng bản địa chuẩn!**

---

## Cách chạy nhanh

Mở Terminal tại thư mục gốc của khóa học và chạy:

### 1. Tạo thử Chương 1 trước (~1–2 phút)
```bash
bash "Cong-Cu-Tao-Audio-Video/setup_and_generate.sh" 1
```

### 2. Tạo toàn bộ các chương (tất cả MP3 + M4A + video MP4)
```bash
bash "Cong-Cu-Tao-Audio-Video/setup_and_generate.sh" all
```

### 3. Các tùy chọn nâng cao (khi đã cài `.venv-media`)
- **Chỉ tạo Audio MP3 cho Slide Tương Tác (nhanh hơn, không dựng MP4):**
  ```bash
  .venv-media/bin/python Cong-Cu-Tao-Audio-Video/generate_media.py --all --cards-only
  ```
- **Xuất Video dọc 9:16 (1080×1920) cho Shorts / TikTok / Reels:**
  ```bash
  .venv-media/bin/python Cong-Cu-Tao-Audio-Video/generate_media.py --chapters 1 --video-only --portrait
  ```
- **Chỉnh tốc độ đọc bản địa chậm hơn nữa (ví dụ `-15%`):**
  ```bash
  .venv-media/bin/python Cong-Cu-Tao-Audio-Video/generate_media.py --chapters 1 2 --rate="-15%"
  ```
- **Chỉ render lại video & track M4A khi đã có sẵn MP3 (rất nhanh khi đổi font hoặc giao diện):**
  ```bash
  .venv-media/bin/python Cong-Cu-Tao-Audio-Video/generate_media.py --all --video-only
  ```

---

## Cấu trúc file đầu ra

- `Media-Audio/cards/<id>.mp3`: Audio từng từ vựng, mẫu câu, lượt hội thoại, câu kiểm tra.
- `Media-Audio/prompts_vi/<id>_vi.mp3`: Audio tiếng Việt gợi ý ghép vào video phản xạ.
- `Media-Audio/lessons/<lesson_id>_pimsleur.m4a`: Track luyện nghe–nói liên hoàn cả bài (Việt → nghỉ 2s → Ngoại ngữ x2).
- `Media-Video/Chuong-XX-Flashcard-Nghe-Noi.mp4`: Video flashcard nghe–nói theo từng chương.
