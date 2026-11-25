# ⚡ CTDO YTB MCP (`ctdo-ytb-mcp`)

> **Ultra-Fast, Ultra-Lightweight, Zero-Bloat All-in-One YouTube Model Context Protocol (MCP) Server**
> Tổng hợp toàn diện mọi công nghệ, logic và chức năng từ các YouTube MCP hàng đầu (`ia-programming/youtube-mcp`, `TubeLab YouTube MCP`, `ZubeidHendricks/youtube-mcp-server`, `@kirbah/mcp-youtube`) + tích hợp thêm loạt tính năng thế hệ mới với kiến trúc tối ưu tốc độ & giảm ~85% trọng lượng token cho AI Agents.

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933?logo=node.js)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Stdio%20%2B%20StreamableHTTP-blue)](https://modelcontextprotocol.io/)
[![Dependencies](https://img.shields.io/badge/Runtime%20Deps-Only%202%20(Zero%20Bloat)-brightgreen)](#kiến-trúc-tối-ưu-hiệu-suất--độ-nặng)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## 🌟 Điểm Đột Phá Của CTDO YTB MCP

| Hạng mục | Các YouTube MCP truyền thống | ⚡ **CTDO YTB MCP** |
| :--- | :--- | :--- |
| **Yêu cầu API Key** | Bắt buộc Google Cloud API Key hoặc tốn credit trả phí | **Chạy ngay 100% với 0 API Key** (2026 InnerTube `IOS`/`ANDROID`/`WEB` + RSS) **VÀ** tự động tăng tốc Batch 50x khi gắn `YOUTUBE_API_KEYS` |
| **Độ nặng cài đặt** | `googleapis` (~180MB) hoặc `langchain` + `lancedb` + `pyarrow` (~600MB+) | **Chỉ 2 thư viện runtime** (`@modelcontextprotocol/sdk` + `zod`), `0 vulnerabilities`, khởi động **~35ms** |
| **Độ nặng Context Schema** | 30–40 tool rời rạc chiếm ~10,000–18,000 tokens mỗi lượt chat | **3 chế độ trọng lượng (`lite`: ~880 tokens, `compact`: ~2,200 tokens, `full`: 45 tools)** + tự động nén JSON loại bỏ `null`/rỗng giảm **85% output tokens** |
| **Tốc độ & Cache** | Gọi mạng lặp lại hoặc bắt cài MongoDB ngoài | **2 tầng Cache tích hợp sẵn**: L1 Memory LRU (**`0.18ms`**) + L2 Native `node:sqlite` WAL bền vững + **Singleflight** gộp request trùng lặp |
| **Outlier & Niche Analytics** | Tốn phí subscription / credit | **Miễn phí không giới hạn**: Outlier Video Finder (`views/subs`), Consistent Outlier Channels, Trending Title Templates, Niche RPM/Saturation Validator |
| **Local Vector RAG** | Nặng nề, lỗi font tiếng Việt/Unicode | **Native SQLite FTS5 BM25 + Cosine Vector RRF** hỗ trợ tiếng Việt/đa ngôn ngữ, trả về đúng link timestamp `https://youtu.be/ID?t=Xs` trong **`<2ms`** |
| **Tính năng mở rộng độc quyền** | Không có | **SponsorBlock** (tự cắt quảng cáo/intro), **ReturnYouTubeDislike**, **Comment Mining** (lọc câu hỏi/ý tưởng/nỗi đau khán giả), **Dịch phụ đề tức thì (`translateTo: "vi"`)**, **Packaging & 40s Hook WPM Audit** |

---

## 🧠 Tổng Hợp Toàn Diện Công Nghệ Từ Hệ Sinh Thái + Mở Rộng Mới

1. **Từ `ia-programming/youtube-mcp` (Nâng cấp toàn diện)**:
   - Tìm kiếm YouTube & lấy transcript không cần API key.
   - Lưu trữ & tìm kiếm ngữ nghĩa (RAG) trên kho video đã index — nâng cấp từ LanceDB/PyArrow sang **SQLite FTS5 BM25 + 256-dim Hybrid Vector RRF** phân đoạn theo mốc thời gian thực (tự động nâng cấp lên Neural Embeddings nếu có `GEMINI_API_KEY` hoặc `OPENAI_API_KEY`).
2. **Từ `TubeLab YouTube MCP` (`tubelab.net/youtube-mcp`)**:
   - Đầy đủ bộ công cụ nghiên cứu ngách & viral: `search_outliers`, `search_related_outliers`, `search_related_channels`, `search_trending_formats` (trích xuất công thức tiêu đề viral), `get_channel`, `get_channel_videos`, `get_channel_shorts`, `get_video`, `get_video_transcript`, `get_video_comments`, `get_credits_balance` (hỗ trợ cả key TubeLab thật nếu cấu hình `TUBELAB_API_KEY`).
3. **Từ `ZubeidHendricks/youtube-mcp-server`**:
   - Pool nhiều `YOUTUBE_API_KEY` tự động xoay vòng khi hết hạn mức (quota failover).
   - Khám phá Creator theo chủ đề (`find_creators`), tự động bóc tách **Email liên hệ & Social Links** từ mô tả kênh, bộ phân loại **Creator vs Brand/Media**, lọc theo khoảng Subscribers (`minSubs`–`maxSubs`), giao thức kép `stdio` + `StreamableHTTP` (`/mcp` & `/ready`).
4. **Từ `@kirbah/mcp-youtube`**:
   - Nén payload giảm ~85% context tokens, xử lý theo lô (**Batch 50 videos/channels** chỉ tốn 1 quota unit).
   - Chế độ transcript `key_segments` (chỉ trích xuất **45s Mở đầu Hook + 35s Kết thúc CTA**), thuật toán 4 pha `findConsistentOutlierChannels`, cùng hệ thống **MCP Resources** (`youtube://transcript/{id}`).
5. **Chức năng mới do CTDO YTB MCP bổ sung**:
   - **SponsorBlock Integration**: Phát hiện & loại bỏ đoạn quảng cáo sponsor, intro/outro khỏi transcript, lấy mốc **Highlight (Most Replayed)**.
   - **ReturnYouTubeDislike**: Lấy số lượng Dislike thực tế & tỷ lệ đồng thuận (`approvalPct`).
   - **Audience Intelligence Comment Miner**: Tự động phân tích hàng loạt bình luận thành **Câu hỏi chưa được giải đáp**, **Yêu cầu làm video mới**, **Điểm chê/lỗi**, **Timestamp khán giả đánh dấu** và **Điểm cảm xúc (Sentiment)**.
   - **Packaging, CTR & 40s Hook Analyzer**: Chấm điểm CTR tiêu đề, đo tốc độ nói (**WPM - Words Per Minute**), kiểm tra Open-Loop trong 40 giây đầu, mật độ từ khóa SEO và xuất ảnh Thumbnail gốc độ phân giải cao nhất.
   - **Dịch Phụ Đề Trực Tiếp (`translateTo`)**: Dịch phụ đề bất kỳ video nào sang tiếng Việt (`vi`), Anh (`en`), Nhật (`ja`), Hàn (`ko`)... không tốn token của LLM.
   - **Niche Viability & RPM Estimator**: Ước tính biên độ RPM/CPM (USD), tỷ lệ kênh nhỏ (<50K subs) bùng nổ view và chấm điểm cơ hội ngách (0–100).

---

## 🚀 Cài Đặt Nhanh (Quick Start)

```bash
git clone https://github.com/thanhdo1110/CTDO-YTB-MCP.git
cd CTDO-YTB-MCP
npm install
npm run build
```

### Cấu hình cho Claude Desktop / Cursor / Antigravity / Windsurf

#### 🟢 Chế độ Zero-Config (Không cần bất kỳ API Key nào!)
```json
{
  "mcpServers": {
    "ctdo-ytb-mcp": {
      "command": "node",
      "args": ["/Users/dothanh1110/Desktop/youtube-mcp/dist/cli.js"]
    }
  }
}
```

#### ⚡ Chế độ Full-Power (Tuỳ chọn thêm Pool API Keys & Chế độ trọng lượng)
```json
{
  "mcpServers": {
    "ctdo-ytb-mcp": {
      "command": "node",
      "args": ["/Users/dothanh1110/Desktop/youtube-mcp/dist/cli.js", "--mode=compact"],
      "env": {
        "YOUTUBE_API_KEYS": "AIzaSyKey1...,AIzaSyKey2...",
        "CTDO_TOOL_MODE": "compact",
        "CTDO_OUTPUT_FORMAT": "compact",
        "CTDO_DEFAULT_LANG": "vi"
      }
    }
  }
}
```

#### 🌐 Chạy dưới dạng StreamableHTTP Server
```bash
npm run start:http
# Endpoint MCP:      http://127.0.0.1:8088/mcp
# Health & Telemetry: http://127.0.0.1:8088/ready
```

---

## 🛠️ 3 Chế Độ Trọng Lượng Tool (`CTDO_TOOL_MODE`)

> **Lưu ý đặc biệt**: Dù bạn bật `lite` hay `compact` để tiết kiệm tối đa token trên mỗi lượt hội thoại, bộ định tuyến `call_tool` bên dưới vẫn **luôn chấp nhận tất cả 45 tên tool** (bao gồm mọi tên tool gốc của TubeLab, Zubeid, Kirbah và IA-Programming)!

- **`lite` (`4 tools` — ~881 tokens)**: Siêu gọn nhẹ cho các mô hình local nhỏ (`yt_search`, `yt_videos`, `yt_transcript`, `yt_channels`).
- **`compact` (Mặc định — `12 Power Tools` — ~2,228 tokens)**: Bao phủ **100% toàn bộ tính năng** với thiết kế gộp thông minh:
  1. `yt_search` — Tìm kiếm `video`, `short`, `channel`, `playlist`, `trending`, `categories` kèm bộ lọc subs/creator/ngày đăng.
  2. `yt_videos` — Lấy thông tin sâu hàng loạt (tới 50 videos/lần) + `chapters` + `SponsorBlock` + `ReturnYouTubeDislike`.
  3. `yt_transcript` — Lấy phụ đề đa chế độ (`key_segments`, `full`, `timestamped`, `chapters`, `search`, `srt`, `vtt`), dịch tự động (`translateTo`), cắt quảng cáo (`stripSponsors`), lưu thẳng ra file (`saveToFile`).
  4. `yt_channels` — Phân tích kênh qua `@handle`/URL/ID + tab `videos`, `shorts`, `top_videos`, `playlists`, `rss` + bóc tách email/links & phân loại Creator.
  5. `yt_comments` — Lấy bình luận (`list`) hoặc khai phá insight khán giả (`mine`: câu hỏi, ý tưởng video, phàn nàn, mốc thời gian, cảm xúc).
  6. `yt_playlists` — Thông tin playlist & toàn bộ danh sách video.
  7. `yt_outliers` — Động cơ viral: `videos` (Outlier Finder), `related_outliers`, `consistent_channels` (4-phase), `trending_formats` (công thức tiêu đề).
  8. `yt_discover` — Nghiên cứu đối thủ & ngách: `related_channels`, `find_creators`, `analyze_niche` (thẩm định ngách & RPM), `compare_channels` (ma trận đối sánh 2–10 kênh).
  9. `yt_packaging` — Chấm điểm CTR tiêu đề, nhịp độ nói 40s đầu (WPM), cấu trúc Open-Loop, SEO tags & link ảnh Thumbnail MaxRes.
  10. `yt_kb` — Cơ sở tri thức RAG nội bộ (`index`, `search`, `list`, `remove`, `clear`) trên SQLite FTS5 + Vector RRF.
  11. `yt_export` — Xuất phụ đề `.srt`/`.vtt`, ảnh thumbnail chất lượng gốc, file JSON hoặc lấy luồng audio qua `yt-dlp`.
  12. `yt_system` — Xem hiệu suất L1/L2 cache, quota tiết kiệm được, trạng thái API key pool, số dư TubeLab hoặc dọn cache.
- **`full` (`45 tools` — ~4,400 tokens)**: Hiển thị tường minh cả 12 Power Tools lẫn 33 tool tương thích 1-1 với TubeLab, Zubeid, Kirbah, IA-Programming.

---

## 📦 MCP Resources & Prompts Tích Hợp Sẵn

### Resources (Đọc trực tiếp qua URI)
- `youtube://transcript/{videoId}` — Đọc toàn bộ phụ đề video
- `youtube://transcript/{videoId}/{lang}` — Đọc/dịch phụ đề sang ngôn ngữ bất kỳ (VD: `youtube://transcript/dQw4w9WgXcQ/vi`)
- `youtube://video/{videoId}` — Metadata gọn nhẹ + Chapters + SponsorBlock + Dislikes
- `youtube://channel/{handleOrId}` — Hồ sơ kênh + email/link + video mới nhất
- `youtube://system/telemetry` — Thống kê cache & quota trực tiếp

### Prompts (Workflows tự động cho Creator & Researcher)
- `viral-outlier-blueprint` — Tìm outlier + rút công thức tiêu đề + đào bình luận -> đề xuất 5 ý tưởng video CTR cao
- `channel-growth-audit` — Khám bệnh kênh toàn diện (tiêu đề, hook WPM, tỷ lệ Shorts/Long, khoảng trống đối thủ)
- `video-deep-digest` — Tóm tắt sâu theo từng Chapter (đã lọc quảng cáo SponsorBlock) + tổng hợp Q&A từ bình luận
- `niche-viability-report` — Báo cáo thẩm định ngách, tỷ lệ kênh mới bùng nổ & ước tính doanh thu RPM

---

## 📊 Kết Quả Kiểm Thử & Benchmark Thực Tế

```bash
npm test      # Chạy toàn bộ Unit + Live E2E MCP Protocol Tests
npm run bench # Chạy Benchmark đo trọng lượng Schema Token & độ trễ Cache
```

- **Cold Fetch Transcript (0 API Key)**: `~260 ms`
- **Warm L1 Memory Cache Hit**: **`~0.18 ms`** (nhanh hơn ~1,400 lần)
- **Warm L2 SQLite WAL Hit (sau khi khởi động lại tiến trình)**: **`~0.4 ms`**
- **Hybrid RAG Search trên kho phụ đề đã lưu**: **`< 2.0 ms`**

---

## 📄 License

Phát hành theo giấy phép [MIT](./LICENSE) — Thiết kế & tối ưu bởi **CTDO**.
