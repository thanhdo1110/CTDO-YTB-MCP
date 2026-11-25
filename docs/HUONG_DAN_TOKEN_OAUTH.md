# 🔐 Hướng Dẫn Toàn Tập: Lấy Token, Google OAuth 2.0, API Keys & Quản Trị Kênh (`CTDO YTB MCP`)

Tài liệu này hướng dẫn chi tiết từ A–Z toàn bộ các loại khóa/token hỗ trợ trong **CTDO YTB MCP** — từ chế độ **không cần bất kỳ token nào (0-Config)** cho đến kết nối sâu **quyền chủ kênh YouTube Studio (OAuth 2.0 PKCE)** kèm cách xử lý mọi lỗi thực tế trên Google Cloud Console.

---

## 📋 Bảng Tóm Tắt: Khi Nào Cần Loại Token Nào?

| Nhu cầu sử dụng | Cần gì? | Bắt buộc? | Cách hoạt động |
| :--- | :--- | :---: | :--- |
| Tìm kiếm video/kênh, lấy phụ đề, dịch phụ đề sang tiếng Việt, đào bình luận, tìm Outlier Videos, thẩm định ngách & RPM, lưu kho RAG nội bộ | **Không cần gì cả!** | ❌ Không | Chạy trực tiếp qua **2026 InnerTube Engine (`IOS` + `ANDROID` + `WEB`) + RSS + SQLite FTS5** |
| Tăng tốc độ quét hàng loạt 50 videos/channels mỗi 1 request | `YOUTUBE_API_KEY` (hoặc `YOUTUBE_API_KEYS=k1,k2,k3`) | 🟡 Tuỳ chọn | Tự động xoay vòng nhiều key khi hết 10,000 quota/ngày; nếu hết sạch tự động lùi về InnerTube không gián đoạn |
| **Quản trị kênh chính chủ & Đọc YouTube Studio riêng tư** (Xem Retention %, nguồn Traffic, Doanh thu, Sửa SEO hàng loạt, Đổi Banner/Thumbnail `16:9` & `9:16` Shorts, Upload `.MOV`/`.MP4`, Đăng/Sửa bình luận chủ kênh) | **Google OAuth 2.0 Desktop (`client_secret.json`)** | ✅ Cần khi quản trị kênh riêng | Đăng nhập 1 lần qua trình duyệt (`ctdo-ytb-mcp login`), tự lưu `refresh_token` mã hóa quyền `0600` tại `~/.ctdo-ytb-mcp/account.json` và tự gia hạn ngầm vĩnh viễn |
| Tìm kiếm ngữ nghĩa sâu (Dense Neural Vector Embeddings) trong `yt_kb` | `GEMINI_API_KEY` hoặc `OPENAI_API_KEY` | 🟡 Tuỳ chọn | Mặc định đã có sẵn bộ băm vector 256 chiều nội bộ siêu nhanh `<2ms`; thêm key sẽ nâng cấp lên `gemini-embedding-001` / `text-embedding-3-small` |

---

## 🔑 Phần 1: Hướng Dẫn Lấy Token Chủ Kênh YouTube Studio (Google OAuth 2.0 — A đến Z)

Chỉ mất khoảng **2 phút** trên Google Cloud Console (hoàn toàn miễn phí) để cấp toàn quyền quản trị kênh YouTube cá nhân cho AI Agent của bạn:

### Bước 1: Tạo Project & Bật 2 API YouTube
1. Truy cập [Google Cloud Console](https://console.cloud.google.com/) và tạo một Project mới (hoặc chọn Project sẵn có).
2. Bấm vào 2 đường dẫn dưới đây và nhấn nút **Enable (Bật)** cho cả hai:
   - **YouTube Data API v3** *(quản lý video, thumbnail, ảnh bìa, bình luận, upload)*:
     https://console.cloud.google.com/apis/library/youtube.googleapis.com
   - **YouTube Analytics API** *(đọc báo cáo YouTube Studio: phút xem, % giữ chân, nguồn traffic, doanh thu)*:
     https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com

### Bước 2: Cấu Hình OAuth Consent Screen & Thêm Test User *(Quan Trọng Nhất!)*
> ⚠️ **CẢNH BÁO LỖI `403: access_denied`:** Nếu bỏ qua bước thêm Gmail vào **Test users**, khi đăng nhập Google sẽ chặn với thông báo: *"Ứng dụng chưa hoàn tất quy trình xác minh của Google — Lỗi 403: access_denied"*.

1. Mở trang **Google Auth Platform → Branding / OAuth consent screen**:
   https://console.cloud.google.com/auth/overview
2. Chọn loại **External (Bên ngoài)** → đặt tên ứng dụng bất kỳ (ví dụ: `CTDO YTB MCP`), điền email hỗ trợ của bạn → bấm **Save / Create**.
3. Chuyển sang tab **Audience (Đối tượng)** bên thanh menu trái:
   https://console.cloud.google.com/auth/audience
4. Kéo xuống mục **Test users (Người dùng thử nghiệm)** → bấm **+ Add users** → **nhập chính xác địa chỉ Gmail đang sở hữu kênh YouTube của bạn** → bấm **Save**.

### Bước 3: Tạo OAuth Client ID (`Desktop app`) & Tải `client_secret.json`
1. Mở trang **Credentials / Clients**:
   https://console.cloud.google.com/apis/credentials
2. Nhấn **+ Create Credentials** → chọn **OAuth client ID**.
3. Tại ô **Application type**, bắt buộc chọn **`Desktop app`** *(loại Desktop app mặc định cho phép cổng loopback `http://localhost:8919` chuẩn PKCE mà không cần khai báo Redirect URI thủ công)*.
4. Đặt tên (ví dụ: `CTDO Desktop Client`) → bấm **Create**.
5. Nhấn **Download JSON** để tải tệp `client_secret_xxx.json` về máy (hoặc copy lại `Client ID` và `Client secret`).
   *(Lưu ý bảo mật: Tuyệt đối lưu tệp này ở thư mục riêng như `~/.ctdo-ytb-mcp/client_secret.json`, không bao giờ đẩy `client_secret.json` hay `account.json` lên GitHub công khai!).*

### Bước 4: Chạy Lệnh Đăng Nhập Tự Động Nhận & Lưu `refresh_token`
Mở Terminal và chạy một trong hai lệnh sau:

```bash
# Cách 1: Truyền đường dẫn file JSON vừa tải về
ctdo-ytb-mcp login --client-secret=/đường/dẫn/tới/client_secret.json

# Cách 2: Hoặc truyền trực tiếp Client ID & Client Secret
ctdo-ytb-mcp login --client-id="XXXX.apps.googleusercontent.com" --secret="GOCSPX-XXXX"
```

**Quy trình tự động diễn ra:**
1. CLI tự khởi tạo máy chủ lắng nghe cục bộ chuẩn Dual-Stack (`IPv4 + IPv6`) tại `http://localhost:8919` và tự động bật trình duyệt mở trang cấp quyền Google.
2. Bạn chọn đúng tài khoản kênh YouTube (nếu tài khoản Google có nhiều Brand Channel, chọn đúng kênh bạn muốn gắn).
3. Khi thấy màn hình *"Google chưa xác minh ứng dụng này"*, nhấn **Tiếp tục (Continue)** → **Tích chọn tất cả các ô quyền** → nhấn **Tiếp tục (Allow)**.
4. Trình duyệt báo **`✅ Đã kết nối kênh "..." vào CTDO YTB MCP!`**.
5. Toàn bộ `access_token`, `refresh_token` và thông tin kênh được lưu bảo mật (`chmod 600`) tại:
   ```text
   ~/.ctdo-ytb-mcp/account.json
   ```
   Từ thời điểm này trở đi, **CTDO YTB MCP tự động làm mới `access_token` ngầm mỗi khi hết hạn 60 phút** — bạn không cần đăng nhập lại!

---

## ⚡ Phần 2: Hướng Dẫn Lấy Pool Nhiều `YOUTUBE_API_KEY` (Tăng Tốc Batch & Chống Hết Quota)

Mỗi Project trên Google Cloud được cấp miễn phí **10,000 quota units/ngày** cho YouTube Data API v3. Để không bao giờ lo chạm trần khi quét dữ liệu lớn:

1. Vào https://console.cloud.google.com/apis/credentials → **+ Create Credentials** → **API key**.
2. *(Khuyến nghị bảo mật)* Bấm vào API key vừa tạo → mục **API restrictions** → chọn **Restrict key** → chỉ tích chọn **YouTube Data API v3** → **Save**.
3. Bạn có thể tạo 2–4 key từ các project khác nhau và nối bằng dấu phẩy trong biến môi trường `YOUTUBE_API_KEYS`:

```json
{
  "mcpServers": {
    "ctdo-ytb-mcp": {
      "command": "node",
      "args": ["/đường/dẫn/tới/CTDO-YTB-MCP/dist/cli.js"],
      "env": {
        "YOUTUBE_API_KEYS": "AIzaSyKey_1...,AIzaSyKey_2...,AIzaSyKey_3...",
        "GOOGLE_CLIENT_ID": "XXXX.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "GOCSPX-XXXX",
        "CTDO_TOOL_MODE": "compact",
        "CTDO_OUTPUT_FORMAT": "compact"
      }
    }
  }
}
```

---

## 🛠️ Phần 3: Các Kịch Bản Xử Lý Sự Cố Thực Tế (Troubleshooting)

1. **Lỗi `403: access_denied` khi bấm đăng nhập OAuth:**
   - **Nguyên nhân:** Email kênh YouTube chưa nằm trong danh sách `Test users`.
   - **Cách sửa:** Vào `Google Auth Platform → Audience → Test users` thêm đúng Gmail đó rồi bấm lại link đăng nhập.
2. **Đổi phần Giới thiệu kênh (`brandingSettings`) nhưng giao diện tiếng Việt vẫn hiện mô tả cũ:**
   - **Nguyên nhân:** Kênh có bật đa ngôn ngữ (`localizations.vi_VN`) ghi đè lên mô tả gốc, và YouTube API cấm gửi chung `part=brandingSettings,localizations` trong cùng 1 lệnh `PUT`.
   - **Cách sửa:** Dùng `yt_studio(action="update_channel_branding", description="...", title="Tên Kênh")` — CTDO YTB MCP đã tự động tách thành 2 lệnh `PUT` độc lập để đồng bộ cả `brandingSettings` lẫn `localizations.vi_VN` & `en_US`!
3. **Vừa Upload video Shorts `.MOV`/`.MP4` xong nhưng chưa hiện ảnh bìa dọc `9:16`:**
   - **Nguyên nhân:** Trong 10–30 giây đầu khi video `HEVC`/`.MOV` vừa tải lên, máy chủ YouTube còn ở trạng thái `processingStatus: "processing"` nên chưa kích hoạt trường `shortsAspectRatio` (`1080×1920` `sardefault.jpg`).
   - **Cách sửa:** Công cụ `yt_studio(action="upload_video", thumbnailPath="...")` từ bản `v1.2.0` đã tự động chờ `processingStatus === "succeeded"` rồi mới gắn ảnh thu nhỏ dọc để kích hoạt chuẩn `shortsAspectRatio=1080x1920` ngay lập tức!
4. **Trình duyệt vẫn hiển thị Thumbnail hoặc Ảnh bìa cũ sau khi API báo `HTTP 200`:**
   - **Nguyên nhân:** Trình duyệt lưu cache đĩa (`max-age`) cho miền `i.ytimg.com` và `yt3.googleusercontent.com` từ 15–30 phút.
   - **Cách sửa:** Nhấn **`Cmd + Shift + R`** (macOS) / **`Ctrl + F5`** (Windows) hoặc mở cửa sổ Ẩn danh để thấy ảnh mới trên CDN ngay lập tức.
