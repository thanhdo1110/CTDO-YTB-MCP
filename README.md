# ⚡ CTDO YTB MCP (`ctdo-ytb-mcp` v1.2.0)

> **Ultra-Fast, Ultra-Lightweight, Zero-Bloat All-in-One YouTube MCP Server + YouTube Studio OAuth2 & Apple HIG 2026 Media Engine**
> Tổng hợp toàn diện mọi công nghệ, logic và chức năng từ các YouTube MCP hàng đầu (`ia-programming/youtube-mcp`, `TubeLab YouTube MCP`, `ZubeidHendricks/youtube-mcp-server`, `@kirbah/mcp-youtube`) + tích hợp **Quản trị kênh chính chủ YouTube Studio OAuth 2.0**, **Bộ kết xuất Banner tràn viền & Thumbnail Dual-Aspect (`16:9` / `9:16` Shorts) chuẩn Apple HIG 2026**, **SponsorBlock**, **Comment Mining** và **SQLite FTS5/Vector RAG**.

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933?logo=node.js)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/Version-1.2.0-0091FF)](#)
[![MCP](https://img.shields.io/badge/MCP-Stdio%20%2B%20StreamableHTTP-blue)](https://modelcontextprotocol.io/)
[![Dependencies](https://img.shields.io/badge/Runtime%20Deps-Only%202%20(Zero%20Bloat)-brightgreen)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

📖 **Tài liệu hướng dẫn chi tiết lấy Token, Google OAuth 2.0 & Xử lý lỗi 403:** Xem ngay tại **[docs/HUONG_DAN_TOKEN_OAUTH.md](./docs/HUONG_DAN_TOKEN_OAUTH.md)**!

---

## 🌟 Điểm Đột Phá Của CTDO YTB MCP v1.2.0

| Hạng mục | Các YouTube MCP thông thường | ⚡ **CTDO YTB MCP v1.2.0** |
| :--- | :--- | :--- |
| **Yêu cầu API Key** | Bắt buộc Google Cloud API Key hoặc tốn credit trả phí | **Chạy ngay 100% với 0 API Key** (2026 InnerTube `IOS`/`ANDROID`/`WEB` + RSS) **VÀ** hỗ trợ Pool nhiều `YOUTUBE_API_KEYS` tự xoay vòng khi hết quota |
| **Kết nối Kênh Cá Nhân & YouTube Studio** | Chỉ đọc dữ liệu công khai, không thể quản trị kênh | **`yt_studio` OAuth 2.0 PKCE chính chủ**: Đọc **YouTube Studio Analytics** (Retention %, Phút xem, Nguồn Traffic, Doanh thu), Sửa SEO hàng loạt (`publicOnly`), Upload `.MOV`/`.MP4`, Đổi Banner/Thumbnail, Upsert bình luận giữ nguyên trạng thái Ghim |
| **Thiết kế Ảnh Bìa & Thumbnail tự động** | Không có | **Tích hợp sẵn Engine `Apple HIG 2026 & Liquid Glass`**: Tự xuất Banner `2560×1440` tràn viền mọi thiết bị (`Desktop` + `Mobile` + `4K TV`) & Thumbnail chuẩn kép **`16:9` (`1920×1080`)** + **`9:16` Shorts (`1080×1920` `shortsAspectRatio`)** |
| **Độ nặng cài đặt & Khởi động** | `googleapis` (~180MB) hoặc `langchain` + `lancedb` (~600MB+) | **Chỉ 2 thư viện runtime** (`@modelcontextprotocol/sdk` + `zod`), `0 vulnerabilities`, khởi động **~35ms** |
| **Độ nặng Context Schema** | 30–40 tool rời rạc tốn ~12,000+ tokens mỗi lượt chat | **3 chế độ trọng lượng (`lite`: 4 tools, `compact`: 13 power tools, `full`: 46 tools)** + nén JSON giảm **~85% output tokens** |
| **Tốc độ & Cache** | Không có cache hoặc bắt cài MongoDB ngoài | **2 tầng Cache tích hợp**: L1 Memory LRU (**`0.18ms`**) + L2 Native `node:sqlite` WAL bền vững + **Singleflight** gộp request đồng thời |
| **Outlier, Niche & RAG** | Tốn phí credit hoặc lỗi tiếng Việt | **Miễn phí 100%**: Outlier Video Finder, Consistent Outlier Channels, Trending Title Formats, Niche RPM Validator, Comment Mining, SponsorBlock & **SQLite FTS5 BM25 + Vector RRF (`<2ms`)** |

---

## 🚀 Cài Đặt Nhanh (Quick Start)

```bash
git clone https://github.com/thanhdo1110/CTDO-YTB-MCP.git
cd CTDO-YTB-MCP
npm install
npm run build

# Tuỳ chọn: Liên kết lệnh toàn cục để gọi `ctdo-ytb-mcp` ở mọi nơi
npm link
```

### 1️⃣ Cấu hình MCP Client ở chế độ Zero-Config (Không cần Token/API Key!)
Thêm vào `~/.gemini/config/mcp_config.json` (Antigravity), `claude_desktop_config.json` (Claude) hoặc `.cursor/mcp.json` (Cursor):

```json
{
  "mcpServers": {
    "ctdo-ytb-mcp": {
      "command": "node",
      "args": ["/đường/dẫn/tuyệt/đối/tới/CTDO-YTB-MCP/dist/cli.js"],
      "env": {
        "CTDO_TOOL_MODE": "compact",
        "CTDO_OUTPUT_FORMAT": "compact"
      }
    }
  }
}
```

### 2️⃣ Kết nối Kênh YouTube Cá Nhân & YouTube Studio (OAuth 2.0)

#### Cách A — Gắn nhanh bằng `@handle` (1 giây, không cần OAuth, dùng để theo dõi & audit kênh):
```bash
ctdo-ytb-mcp bind @ten_kenh_cua_ban
```

#### Cách B — Đăng nhập Google OAuth 2.0 Chủ Kênh (Mở khóa YouTube Studio Analytics + Sửa SEO + Upload + Đổi Banner/Thumbnail):
1. Trên [Google Cloud Console](https://console.cloud.google.com/):
   - Bật **YouTube Data API v3** và **YouTube Analytics API**.
   - Vào **Google Auth Platform → Audience → Test users** bấm **+ Add users** thêm Gmail chủ kênh của bạn *(bắt buộc để tránh lỗi `403: access_denied`)*.
   - Vào **Credentials → + Create Credentials → OAuth client ID** → chọn loại **`Desktop app`** → tải file JSON về máy.
2. Chạy lệnh đăng nhập (tự động mở trình duyệt và lưu `refresh_token` tự gia hạn ngầm vào `~/.ctdo-ytb-mcp/account.json` với quyền `0600`):
   ```bash
   ctdo-ytb-mcp login --client-secret=/đường/dẫn/tới/client_secret.json
   ```
3. Thêm `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET` vào khối `env` trong `mcp_config.json` để MCP tự làm mới token ngầm trọn đời.
   👉 *Xem hướng dẫn từng bước chi tiết tại [docs/HUONG_DAN_TOKEN_OAUTH.md](./docs/HUONG_DAN_TOKEN_OAUTH.md).*

---

## 🛠️ Danh Sách 13 Power Tools (`compact` mode — Bao phủ 100% 46 công cụ)

1. **`yt_search`**: Tìm kiếm `video`, `short`, `channel`, `playlist`, `trending`, `categories` kèm lọc subscribers, creator-only, thời lượng, ngày đăng.
2. **`yt_videos`**: Batch tối đa 50 videos/lần lấy metadata gọn nhẹ, tỷ lệ tương tác, `chapters`, **SponsorBlock** & **ReturnYouTubeDislike**.
3. **`yt_transcript`**: Lấy phụ đề đa chế độ (`key_segments` Hook 45s + Outro 35s tiết kiệm 85% token, `full`, `timestamped`, `chapters`, `search`, `srt`, `vtt`), **dịch tức thì (`translateTo: "vi"`)**, cắt quảng cáo (`stripSponsors`), lưu thẳng ra đĩa (`saveToFile`).
4. **`yt_channels`**: Hồ sơ kênh qua `@handle`/URL/ID + các tab `videos`, `shorts`, `top_videos`, `playlists`, `rss` + bóc tách Email/Social Links & phân loại Creator vs Brand.
5. **`yt_comments`**: Xem bình luận (`list`) hoặc chạy **Audience Intelligence (`mine`)**: tự động phân nhóm câu hỏi khán giả, yêu cầu làm video mới, điểm chê/lỗi, mốc thời gian khán giả nhắc tới & điểm cảm xúc.
6. **`yt_playlists`**: Chi tiết Playlist & toàn bộ danh sách video.
7. **`yt_outliers`**: Động cơ nghiên cứu viral chuẩn TubeLab & Kirbah: `videos` (Outlier Score = `views/subs`), `related_outliers`, `consistent_channels` (4-phase), `trending_formats` (công thức tiêu đề viral).
8. **`yt_discover`**: Nghiên cứu đối thủ & ngách: `related_channels`, `find_creators`, `analyze_niche` (chấm điểm cơ hội ngách 0–100 & ước tính CPM/RPM USD), `compare_channels` (đối sánh 2–10 kênh).
9. **`yt_packaging`**: Chấm điểm CTR tiêu đề, nhịp độ nói 40s đầu (**WPM**), cấu trúc Open-Loop, mật độ SEO tags & link ảnh Thumbnail gốc.
10. **`yt_kb`**: Kho tri thức **Hybrid RAG nội bộ** (SQLite FTS5 BM25 + 256-dim Cosine Vector RRF / Gemini / OpenAI Embeddings) tìm chính xác câu nói kèm link timestamp `https://youtu.be/ID?t=Xs` trong `<2ms`.
11. **`yt_export`**: Xuất phụ đề `.srt`/`.vtt`, ảnh Thumbnail chất lượng cao, JSON hoặc trích xuất luồng audio qua `yt-dlp`.
12. **`yt_studio`** *(Mới trong v1.1–v1.2)*: Quản trị kênh chính chủ & Thiết kế tự động chuẩn **Apple HIG 2026**:
    - `status` / `bind_channel` / `start_oauth` / `my_overview` / `list_my_videos` (`publicOnly: true` mặc định).
    - `analytics`: Truy vấn báo cáo nội bộ YouTube Studio v2 (`7d`/`28d`/`90d`/`365d` theo ngày, từng video, nguồn traffic `YT_SEARCH`/`SHORTS`...).
    - `update_video`: Tối ưu Title (`<=100` ký tự), Description, Chapters, Tags (`<=450` ký tự), Category, ngôn ngữ & Privacy.
    - `update_channel_branding`: Cập nhật Ảnh bìa kênh `2560×1440` + Giới thiệu kênh + Từ khóa kênh & tự động đồng bộ đa ngôn ngữ (`localizations.vi_VN` / `en_US`).
    - `render_hig_banner` & `render_hig_thumbnail`: Kết xuất trực tiếp Banner tràn viền mọi thiết bị (`Desktop` + `Mobile` + `4K TV`) và Thumbnail chuẩn kép **`16:9` (`1920×1080`)** / **`9:16` Shorts (`1080×1920` `shortsAspectRatio`)** phong cách **Apple HIG 2026 & Liquid Glass** (kèm `applyImmediately: true` đẩy thẳng lên YouTube!).
    - `upsert_creator_comment` & `reply_comment`: Cập nhật bình luận chủ kênh tại chỗ (giữ nguyên huy hiệu Ghim sẵn có) hoặc tạo bình luận chủ kênh mới.
    - `upload_video`: Tải lên video/Shorts `.MOV`/`.MP4` qua Resumable Upload, **tự động chờ YouTube xử lý xong (`processingStatus === "succeeded"`) để kích hoạt ảnh bìa dọc `shortsAspectRatio=1080x1920`** và tự đăng bình luận chủ kênh!
13. **`yt_system`**: Giám sát tỉ lệ trúng cache L1/L2, độ trễ, hạn mức API key pool tiết kiệm được & dọn cache.

*(Khi đặt `CTDO_TOOL_MODE=full`, server hiển thị tường minh toàn bộ 46 công cụ bao gồm tất cả tên hàm gốc của TubeLab, Zubeid, Kirbah và IA-Programming).*

---

## 🧪 Kiểm Thử & Benchmark

```bash
npm test          # Chạy bộ Unit + Live E2E MCP Protocol Tests
npm run bench     # Đo trọng lượng Schema Token & tốc độ L1/SQLite Cache
npm run start:http # Chạy chế độ StreamableHTTP tại http://127.0.0.1:8088/mcp
```

---

## 📄 License

Phát hành theo giấy phép [MIT](./LICENSE) — Thiết kế & phát triển bởi **CTDO (`@thanhdo1110`)**.
