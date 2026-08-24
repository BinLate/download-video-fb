# Download Video / Reel Facebook 🎬

Extension Chrome giúp tải video & reel từ Facebook nhanh chóng, không cần copy link thủ công.

## ✨ Tính năng nổi bật

- **Tải video/reel trực tiếp khi đang xem** — nút tải hiện ngay trên video.
- **Menu popup** — liệt kê mọi video/reel phát hiện được trong tab hiện tại.
- **Dán link tải nhanh** — hỗ trợ link `facebook.com/watch`, `/videos/`, `/reel/`.
- **Thu thập luồng mạng thông minh** — chỉ ghi lại request media trong phiên trích xuất đang hoạt động của tab; video tự động phát khác trong feed **không thể** lẫn vào kết quả (session bị vô hiệu ngay sau khi đã tiêu thụ kết quả).
- **Video đã phát vẫn tải được** — khi bấm tải, extension chủ động quét lại tab (SCAN_NOW) để tạo lại request media của video **đang phát sẵn** bên trong phiên thu thập, rồi mới chạy chuỗi SSR/embed dự phòng.
- **An toàn URL tuyệt đối** — URL được parse thật (`new URL`), bắt buộc HTTPS và so khớp hostname theo quy tắc chính xác `*.fbcdn.net` / `*.fbsbx.com`; URL lừa đảo kiểu `attacker.example/path/fbcdn.net/file` bị chặn (không dùng substring).
- **Chống file hỏng** — manifest DASH `.mpd` được ghi nhận để debug nhưng **không bao giờ** được chọn hoặc đẩy vào trình quản lý tải như file MP4.

## 🔧 Hướng dẫn cài đặt vào trình duyệt

1. Mở Chrome → truy cập `chrome://extensions/`
2. Bật **Developer mode** (chế độ nhà phát triển) ở góc trên bên phải
3. Nhấn **Load unpacked** và chọn thư mục dự án này
4. Ghim extension lên thanh công cụ để dùng nhanh

## 📖 Hướng dẫn sử dụng

### Cách 1: Tải trực tiếp khi đang xem Facebook
Mở video/reel trên Facebook → nút **⬇️ Tải Video** sẽ tự xuất hiện gần video → bấm nút là xong.

### Cách 2: Tải thông qua Menu Popup
Bấm icon extension → danh sách video/reel trong tab hiện tại → chọn chất lượng → **Tải xuống**.

### Cách 3: Dán link tải nhanh
Bấm icon extension → dán link video/reel vào ô nhập → **Tải xuống**.

## 📁 Cấu trúc thư mục

```
demo01/
├── manifest.json          # Khai báo MV3, quyền và entry point
├── background.js          # Service worker: điều phối tải + thu thập mạng
├── content/               # Content script: nút tải trên trang Facebook
├── popup/                 # Giao diện popup
├── icons/                 # Icon extension
└── tests/
    ├── capture.test.mjs   # Unit test logic thu thập (node)
    └── capture_runtime.py # E2E runtime với Chromium thật (playwright)
```

## 🧪 Chạy kiểm thử

```bash
python -m pytest test_extension.py -q   # test tĩnh manifest/quyền
node tests/capture.test.mjs             # unit test logic capture
python tests/capture_runtime.py         # E2E lifecycle với Chrome thật
```

---
*Author: Bin.Late*
