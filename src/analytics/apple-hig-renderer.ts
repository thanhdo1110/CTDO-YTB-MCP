import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getDataDir } from '../core/cache.js';
import { extractVideoId } from '../core/utils.js';

const execFileAsync = promisify(execFile);

export type HIGAccent = 'blue' | 'green' | 'yellow' | 'indigo';
export type HIGAspect = '16:9' | '9:16';

export interface HIGThumbnailRequest {
  videoOrFramePath: string; // Video ID/URL (auto-fetches native frame/oar2) OR local .jpg/.png/.mov/.mp4 path
  outputPath: string;
  aspect?: HIGAspect; // Auto-detected if omitted
  pill: string;
  symbol?: string; // SF Symbol name e.g. 'sparkles', 'apple.terminal.fill', 'iphone.gen3'
  accent?: HIGAccent;
  line1: string;
  line2: string;
  spec: string;
  brandName?: string;
  handle?: string;
  avatarPathOrUrl?: string;
}

export interface HIGBannerRequest {
  outputPath: string;
  overline?: string;
  brandName: string;
  handle: string;
  subtitle: string;
  chips?: Array<{ symbol: string; label: string }>;
}

/**
 * Built-in Apple HIG 2026 & Liquid Glass Studio Graphics Engine:
 * - Renders Full-Bleed All-Device 2560x1440 Channel Banners (Desktop 2560x423 + Mobile 1546x423 + 4K TV 2560x1440)
 * - Renders Dual-Aspect Video Thumbnails:
 *   • 16:9 Landscape (1920x1080) with uncropped 16:9 macOS Sequoia Concentric Bento viewport
 *   • 9:16 Vertical Shorts (1080x1920 native `shortsAspectRatio`) with iPhone Dynamic Island Concentric Bento viewport
 * Uses native macOS Swift CoreGraphics/CoreText/SF Symbols 6 when on macOS, with clean SVG fallback elsewhere.
 */
export async function renderAppleHIGThumbnail(req: HIGThumbnailRequest): Promise<{
  outputPath: string;
  aspect: HIGAspect;
  width: number;
  height: number;
}> {
  mkdirSync(dirname(req.outputPath), { recursive: true });
  const workDir = join(getDataDir(), 'hig_render');
  mkdirSync(workDir, { recursive: true });

  // 1. Resolve source preview frame & auto-detect 16:9 vs 9:16 if needed
  const { framePath, detectedAspect } = await resolvePreviewFrame(req.videoOrFramePath, workDir, req.aspect);
  const aspect: HIGAspect = req.aspect || detectedAspect;

  let avatarPath = '';
  if (req.avatarPathOrUrl) {
    avatarPath = await resolveLocalImage(req.avatarPathOrUrl, join(workDir, 'avatar_cache.jpg'));
  }

  if (process.platform === 'darwin') {
    const bin = await ensureMacRendererCompiled(workDir);
    const jobPath = join(tmpdir(), `ctdo_hig_thumb_${Date.now()}.json`);
    writeFileSync(
      jobPath,
      JSON.stringify({
        mode: 'thumb',
        aspect,
        symbol: req.symbol || (aspect === '9:16' ? 'iphone.gen3' : 'sparkles'),
        pill: req.pill,
        accent: req.accent || 'blue',
        line1: req.line1,
        line2: req.line2,
        spec: req.spec,
        brandName: req.brandName || 'CTDOTEAM',
        handle: req.handle || '@thanhdo1110',
        origPath: framePath,
        avatarPath,
        outPath: req.outputPath,
      })
    );
    await execFileAsync(bin, [jobPath], { timeout: 20_000 });
    return {
      outputPath: req.outputPath,
      aspect,
      width: aspect === '9:16' ? 1080 : 1920,
      height: aspect === '9:16' ? 1920 : 1080,
    };
  }

  // Cross-platform SVG output fallback for non-macOS hosts
  const svgOut = req.outputPath.endsWith('.svg') ? req.outputPath : `${req.outputPath}.svg`;
  const W = aspect === '9:16' ? 1080 : 1920;
  const H = aspect === '9:16' ? 1920 : 1080;
  writeFileSync(
    svgOut,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" fill="#1C1C1E"/>
      <text x="96" y="420" fill="#FFFFFF" font-family="-apple-system,SF Pro Display,sans-serif" font-size="76" font-weight="700">${escapeXml(req.line1)}</text>
      <text x="96" y="520" fill="#5CB8FF" font-family="-apple-system,SF Pro Display,sans-serif" font-size="76" font-weight="700">${escapeXml(req.line2)}</text>
      <text x="96" y="620" fill="#EBEBF5" font-family="-apple-system,SF Pro Text,sans-serif" font-size="32">${escapeXml(req.spec)}</text>
    </svg>`
  );
  return { outputPath: svgOut, aspect, width: W, height: H };
}

export async function renderAppleHIGBanner(req: HIGBannerRequest): Promise<{
  outputPath: string;
  width: number;
  height: number;
}> {
  mkdirSync(dirname(req.outputPath), { recursive: true });
  const workDir = join(getDataDir(), 'hig_render');
  mkdirSync(workDir, { recursive: true });

  if (process.platform !== 'darwin') {
    throw new Error('Native PNG 2560x1440 Apple HIG Banner synthesis requires macOS CoreGraphics/SF Symbols.');
  }

  const bin = await ensureMacRendererCompiled(workDir);
  const jobPath = join(tmpdir(), `ctdo_hig_banner_${Date.now()}.json`);
  writeFileSync(
    jobPath,
    JSON.stringify({
      mode: 'banner',
      overline: req.overline || 'iOS Engineering  ·  Virtualization  ·  Cloud Build  ·  Automation',
      brandName: req.brandName,
      handle: req.handle,
      subtitle: req.subtitle,
      chips: req.chips || [
        { symbol: 'chevron.left.forwardslash.chevron.right', label: 'github.com/thanhdo1110' },
        { symbol: 'paperplane.fill', label: 't.me/dothanh1110' },
        { symbol: 'globe', label: 'ctdo.net' },
      ],
      outPath: req.outputPath,
    })
  );
  await execFileAsync(bin, [jobPath], { timeout: 20_000 });
  return { outputPath: req.outputPath, width: 2560, height: 1440 };
}

async function resolveLocalImage(pathOrUrl: string, destPath: string): Promise<string> {
  if (existsSync(pathOrUrl)) return pathOrUrl;
  if (pathOrUrl.startsWith('http')) {
    const res = await fetch(pathOrUrl);
    if (res.ok) {
      writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
      return destPath;
    }
  }
  return '';
}

async function resolvePreviewFrame(
  input: string,
  workDir: string,
  aspectHint?: HIGAspect
): Promise<{ framePath: string; detectedAspect: HIGAspect }> {
  if (existsSync(input)) {
    const lower = input.toLowerCase();
    if (lower.endsWith('.mov') || lower.endsWith('.mp4') || lower.endsWith('.m4v')) {
      const outFrame = join(workDir, `video_frame_${Date.now()}.jpg`);
      if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('swift', [
          '-e',
          `import AVFoundation; import AppKit
           let asset = AVURLAsset(url: URL(fileURLWithPath: ${JSON.stringify(input)}))
           let gen = AVAssetImageGenerator(asset: asset)
           gen.appliesPreferredTrackTransform = true
           let dur = CMTimeGetSeconds(asset.duration)
           let t = CMTime(seconds: max(1.0, min(dur * 0.45, 20.0)), preferredTimescale: 600)
           if let cg = try? gen.copyCGImage(at: t, actualTime: nil) {
             let rep = NSBitmapImageRep(cgImage: cg)
             try! rep.representation(using: .jpeg, properties: [.compressionFactor: 0.92])!.write(to: URL(fileURLWithPath: ${JSON.stringify(outFrame)}))
             print("\\(cg.width)x\\(cg.height)")
           }`,
        ]);
        const [w, h] = stdout.trim().split('x').map(Number);
        return { framePath: outFrame, detectedAspect: h > w ? '9:16' : '16:9' };
      }
    }
    return { framePath: input, detectedAspect: aspectHint || '16:9' };
  }

  // Input is a YouTube video ID or URL -> download native oar2.jpg (for 9:16 Shorts) or maxresdefault/hqdefault
  const videoId = extractVideoId(input);
  const framePath = join(workDir, `yt_${videoId}.jpg`);

  if (aspectHint !== '16:9') {
    const oarRes = await fetch(`https://i.ytimg.com/vi/${videoId}/oar2.jpg`);
    if (oarRes.ok) {
      const buf = Buffer.from(await oarRes.arrayBuffer());
      if (buf.byteLength > 5000) {
        writeFileSync(framePath, buf);
        return { framePath, detectedAspect: '9:16' };
      }
    }
  }

  for (const variant of ['maxresdefault.jpg', 'hqdefault.jpg']) {
    const res = await fetch(`https://i.ytimg.com/vi/${videoId}/${variant}`);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > 2000) {
        writeFileSync(framePath, buf);
        return { framePath, detectedAspect: aspectHint || '16:9' };
      }
    }
  }

  return { framePath: '', detectedAspect: aspectHint || '16:9' };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function ensureMacRendererCompiled(workDir: string): Promise<string> {
  const binPath = join(workDir, 'ctdo_hig_engine_v2');
  if (existsSync(binPath)) return binPath;

  const swiftPath = join(workDir, 'ctdo_hig_engine_v2.swift');
  writeFileSync(swiftPath, MAC_HIG_SWIFT_SOURCE, 'utf8');
  await execFileAsync('swiftc', ['-O', swiftPath, '-o', binPath], { timeout: 45_000 });
  return binPath;
}

const MAC_HIG_SWIFT_SOURCE = `
import AppKit
import CoreGraphics
import CoreText
import Foundation

struct ChipItem: Decodable {
    let symbol: String
    let label: String
}

struct RenderJob: Decodable {
    let mode: String // "thumb" | "banner"
    let aspect: String?
    let symbol: String?
    let pill: String?
    let accent: String?
    let line1: String?
    let line2: String?
    let spec: String?
    let overline: String?
    let brandName: String?
    let handle: String?
    let subtitle: String?
    let chips: [ChipItem]?
    let origPath: String?
    let avatarPath: String?
    let outPath: String
}

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1.0) -> NSColor {
    return NSColor(srgbRed: r / 255.0, green: g / 255.0, blue: b / 255.0, alpha: a)
}

func makeCtx(_ w: Int, _ h: Int) -> CGContext {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    return ctx
}

func accentColors(_ name: String) -> (fg: NSColor, aura: NSColor, pill: NSColor) {
    switch name {
    case "yellow": return (rgb(254, 223, 67), rgb(255, 214, 0, 0.15), rgb(255, 146, 48, 0.22))
    case "green":  return (rgb(74, 217, 104), rgb(48, 209, 88, 0.15), rgb(48, 209, 88, 0.20))
    case "indigo": return (rgb(167, 170, 255), rgb(109, 124, 255, 0.17), rgb(97, 85, 245, 0.24))
    default:       return (rgb(92, 184, 255), rgb(0, 145, 255, 0.16), rgb(30, 110, 244, 0.24))
    }
}

func loadImg(_ path: String?) -> CGImage? {
    guard let p = path, !p.isEmpty, FileManager.default.fileExists(atPath: p),
          let ns = NSImage(contentsOfFile: p) else { return nil }
    var r = CGRect(origin: .zero, size: ns.size)
    return ns.cgImage(forProposedRect: &r, context: nil, hints: nil)
}

func crop16x9(_ img: CGImage) -> CGImage {
    let w = CGFloat(img.width), h = CGFloat(img.height), ratio = w / h
    if ratio < 1.55 && ratio > 1.25 {
        let th = round(w * 9.0 / 16.0)
        if let c = img.cropping(to: CGRect(x: 0, y: round((h - th) / 2.0), width: w, height: th)) { return c }
    }
    return img
}

func drawFill(_ ctx: CGContext, _ img: CGImage, _ target: CGRect) {
    let iw = CGFloat(img.width), ih = CGFloat(img.height)
    let s = max(target.width / iw, target.height / ih)
    let dw = iw * s, dh = ih * s
    ctx.saveGState()
    ctx.clip(to: target)
    ctx.draw(img, in: CGRect(x: target.midX - dw / 2, y: target.midY - dh / 2, width: dw, height: dh))
    ctx.restoreGState()
}

func drawAura(_ ctx: CGContext, _ c: CGPoint, _ r: CGFloat, _ col: NSColor) {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let g = CGGradient(colorsSpace: cs, colors: [col.cgColor, rgb(0,0,0,0).cgColor] as CFArray, locations: [0,1]) else { return }
    ctx.saveGState()
    ctx.drawRadialGradient(g, startCenter: c, startRadius: 0, endCenter: c, endRadius: r, options: [.drawsAfterEndLocation])
    ctx.restoreGState()
}

func drawBento(_ ctx: CGContext, _ rect: CGRect, _ r: CGFloat, _ fill: NSColor, _ blur: CGFloat = 32) {
    let p = CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil)
    ctx.saveGState()
    if blur > 0 { ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: blur, color: rgb(0,0,0,0.55).cgColor) }
    ctx.setFillColor(fill.cgColor); ctx.addPath(p); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState()
    ctx.addPath(p); ctx.replacePathWithStrokedPath(); ctx.clip()
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    if let g = CGGradient(colorsSpace: cs, colors: [rgb(255,255,255,0.22).cgColor, rgb(255,255,255,0.05).cgColor] as CFArray, locations: [0,1]) {
        ctx.drawLinearGradient(g, start: CGPoint(x: rect.midX, y: rect.maxY), end: CGPoint(x: rect.midX, y: rect.minY), options: [])
    }
    ctx.restoreGState()
}

func drawCapsule(_ ctx: CGContext, _ rect: CGRect, _ tint: NSColor?) {
    let r = rect.height / 2.0
    let p = CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -4), blur: 14, color: rgb(0,0,0,0.35).cgColor)
    ctx.setFillColor((tint ?? rgb(58,58,62,0.65)).cgColor); ctx.addPath(p); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState()
    ctx.setStrokeColor(rgb(255,255,255,0.28).cgColor); ctx.setLineWidth(1.3); ctx.addPath(p); ctx.strokePath()
    ctx.restoreGState()
}

func measure(_ t: String, _ s: CGFloat, _ w: NSFont.Weight, _ k: CGFloat = 0) -> CGSize {
    return NSAttributedString(string: t, attributes: [.font: NSFont.systemFont(ofSize: s, weight: w), .kern: k]).size()
}

@discardableResult
func drawTxt(_ t: String, _ pt: CGPoint, _ s: CGFloat, _ w: NSFont.Weight, _ fg: NSColor, _ k: CGFloat = 0) -> CGSize {
    let a = NSAttributedString(string: t, attributes: [.font: NSFont.systemFont(ofSize: s, weight: w), .foregroundColor: fg, .kern: k])
    a.draw(at: pt); return a.size()
}

@discardableResult
func drawSym(_ n: String, _ pt: CGPoint, _ s: CGFloat, _ col: NSColor) -> CGSize {
    guard let b = NSImage(systemSymbolName: n, accessibilityDescription: nil),
          let sym = b.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: s, weight: .semibold).applying(.init(hierarchicalColor: col))) else { return .zero }
    sym.draw(in: CGRect(origin: pt, size: sym.size)); return sym.size
}

let data = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let job = try! JSONDecoder().decode(RenderJob.self, from: data)

if job.mode == "banner" {
    let W = 2560, H = 1440
    let ctx = makeCtx(W, H)
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    if let bg = CGGradient(colorsSpace: cs, colors: [rgb(18,22,36).cgColor, rgb(25,31,52).cgColor, rgb(18,24,40).cgColor] as CFArray, locations: [0,0.5,1]) {
        ctx.drawLinearGradient(bg, start: CGPoint(x: 0, y: H), end: CGPoint(x: W, y: 0), options: [])
    }
    drawAura(ctx, CGPoint(x: 220, y: 720), 760, rgb(0,145,255,0.28))
    drawAura(ctx, CGPoint(x: 920, y: 820), 820, rgb(97,85,245,0.26))
    drawAura(ctx, CGPoint(x: 1640, y: 640), 820, rgb(60,211,254,0.22))
    drawAura(ctx, CGPoint(x: 2340, y: 720), 760, rgb(109,124,255,0.28))
    drawAura(ctx, CGPoint(x: 1280, y: 720), 620, rgb(10,14,26,0.50))

    let over = job.overline ?? "iOS Engineering  ·  Virtualization  ·  Automation"
    let overW = measure(over, 21, .semibold, -0.2).width + 82
    let ox = (CGFloat(W) - overW) / 2.0
    drawCapsule(ctx, CGRect(x: ox, y: 844, width: overW, height: 48), rgb(30,110,244,0.36))
    let st = drawSym("apple.terminal.fill", CGPoint(x: ox + 22, y: 857), 19, .white)
    drawTxt(over, CGPoint(x: ox + 22 + st.width + 12, y: 856), 21, .semibold, .white, -0.2)

    let brand = job.brandName ?? "CTDOTEAM"
    let handle = job.handle ?? "@thanhdo1110"
    let bSz = measure(brand, 108, .heavy, -3.2)
    let hSz = measure(handle, 34, .semibold, -0.5)
    let startX = (CGFloat(W) - (bSz.width + 78 + hSz.width)) / 2.0
    drawTxt(brand, CGPoint(x: startX, y: 700), 108, .heavy, .white, -3.2)
    let sl = drawSym("checkmark.seal.fill", CGPoint(x: startX + bSz.width + 18, y: 734), 42, rgb(92,184,255))
    drawTxt(handle, CGPoint(x: startX + bSz.width + 18 + sl.width + 14, y: 737), 34, .semibold, rgb(190,224,255), -0.5)

    let sub = job.subtitle ?? ""
    let sSz = measure(sub, 28, .medium, -0.3)
    drawTxt(sub, CGPoint(x: (CGFloat(W) - sSz.width) / 2.0, y: 638), 28, .medium, rgb(235,235,245,0.92), -0.3)

    let chips = job.chips ?? []
    let widths = chips.map { measure($0.label, 22, .semibold, -0.2).width + 84 }
    var cx = (CGFloat(W) - (widths.reduce(0,+) + CGFloat(max(0, chips.count - 1)) * 18)) / 2.0
    for (i, c) in chips.enumerated() {
        drawCapsule(ctx, CGRect(x: cx, y: 544, width: widths[i], height: 54), rgb(28,34,52,0.72))
        let sd = drawSym(c.symbol, CGPoint(x: cx + 22, y: 560), 19, rgb(92,184,255))
        drawTxt(c.label, CGPoint(x: cx + 22 + sd.width + 12, y: 558), 22, .semibold, .white, -0.2)
        cx += widths[i] + 18
    }
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: job.outPath))
} else {
    let isShort = (job.aspect == "9:16")
    let W = isShort ? 1080 : 1920
    let H = isShort ? 1920 : 1080
    let ctx = makeCtx(W, H)
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    let acc = accentColors(job.accent ?? "blue")
    ctx.setFillColor(rgb(0,0,0).cgColor); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    let card = CGRect(x: 20, y: 20, width: W - 40, height: H - 40)
    drawBento(ctx, card, 48, rgb(28,28,30), 0)
    drawAura(ctx, CGPoint(x: W / 3, y: H * 3 / 4), 640, acc.aura)

    let pill = job.pill ?? "CTDOTEAM"
    let symName = job.symbol ?? "sparkles"
    let l1 = job.line1 ?? ""
    let l2 = job.line2 ?? ""
    let sp = job.spec ?? ""
    let brand = job.brandName ?? "CTDOTEAM"
    let handle = job.handle ?? "@thanhdo1110"

    if isShort {
        let pw = measure(pill, 30, .semibold, -0.3).width + 96
        let px = (CGFloat(W) - pw) / 2.0
        drawCapsule(ctx, CGRect(x: px, y: 1636, width: pw, height: 66), acc.pill)
        let sd = drawSym(symName, CGPoint(x: px + 26, y: 1654), 26, .white)
        drawTxt(pill, CGPoint(x: px + 26 + sd.width + 14, y: 1652), 30, .semibold, .white, -0.3)

        var hs: CGFloat = 82
        while hs > 48 && (measure(l1, hs, .bold, -2.0).width > 928 || measure(l2, hs, .bold, -2.0).width > 928) { hs -= 2 }
        drawTxt(l1, CGPoint(x: (CGFloat(W) - measure(l1, hs, .bold, -2.0).width)/2, y: 1512), hs, .bold, .white, -2.0)
        drawTxt(l2, CGPoint(x: (CGFloat(W) - measure(l2, hs, .bold, -2.0).width)/2, y: 1408), hs, .bold, acc.fg, -2.0)

        let sw = min(928, measure(sp, 28, .medium, -0.2).width + 48)
        let sx = (CGFloat(W) - sw) / 2.0
        drawBento(ctx, CGRect(x: sx, y: 1314, width: sw, height: 60), 18, rgb(44,44,46), 0)
        drawTxt(sp, CGPoint(x: sx + 24, y: 1328), 28, .medium, rgb(235,235,245,0.88), -0.2)

        let outer = CGRect(x: 150, y: 268, width: 780, height: 990)
        drawBento(ctx, outer, 48, rgb(44,44,46), 44)
        let inner = outer.insetBy(dx: 14, dy: 14)
        if let orig = loadImg(job.origPath) {
            ctx.saveGState()
            ctx.addPath(CGPath(roundedRect: inner, cornerWidth: 34, cornerHeight: 34, transform: nil)); ctx.clip()
            drawFill(ctx, orig, inner)
            ctx.restoreGState()
        }
        let bl = "\\(brand)  ·  \\(handle)"
        let bw = measure(bl, 24, .semibold, -0.3).width + 96
        let bx = (CGFloat(W) - bw) / 2.0
        drawCapsule(ctx, CGRect(x: bx, y: 292, width: bw, height: 58), rgb(28,28,30,0.86))
        let bd = drawTxt(bl, CGPoint(x: bx + 28, y: 307), 24, .semibold, .white, -0.3)
        drawSym("checkmark.seal.fill", CGPoint(x: bx + 28 + bd.width + 8, y: 309), 21, rgb(92,184,255))
    } else {
        let outer = CGRect(x: 944, y: 263, width: 888, height: 554)
        drawBento(ctx, outer, 32, rgb(44,44,46), 44)
        let inner = outer.insetBy(dx: 12, dy: 12)
        if let raw = loadImg(job.origPath) {
            ctx.saveGState()
            ctx.addPath(CGPath(roundedRect: inner, cornerWidth: 20, cornerHeight: 20, transform: nil)); ctx.clip()
            drawFill(ctx, crop16x9(raw), CGRect(x: inner.minX, y: inner.minY, width: inner.width, height: inner.height - 44))
            ctx.setFillColor(rgb(28,28,30,0.96).cgColor)
            ctx.fill(CGRect(x: inner.minX, y: inner.maxY - 44, width: inner.width, height: 44))
            ctx.restoreGState()
        }
        let lx: CGFloat = 96
        let pw = measure(pill, 28, .semibold, -0.3).width + 92
        drawCapsule(ctx, CGRect(x: lx, y: 844, width: pw, height: 64), acc.pill)
        let sd = drawSym(symName, CGPoint(x: lx + 24, y: 862), 25, .white)
        drawTxt(pill, CGPoint(x: lx + 24 + sd.width + 14, y: 860), 28, .semibold, .white, -0.3)

        var hs: CGFloat = 86
        while hs > 48 && (measure(l1, hs, .bold, -2.2).width > 800 || measure(l2, hs, .bold, -2.2).width > 800) { hs -= 2 }
        drawTxt(l1, CGPoint(x: lx, y: 668), hs, .bold, .white, -2.2)
        drawTxt(l2, CGPoint(x: lx, y: 552), hs, .bold, acc.fg, -2.2)

        let sw = min(800, measure(sp, 31, .medium, -0.3).width + 52)
        drawBento(ctx, CGRect(x: lx, y: 416, width: sw, height: 70), 20, rgb(44,44,46), 0)
        drawTxt(sp, CGPoint(x: lx + 26, y: 433), 31, .medium, rgb(235,235,245,0.88), -0.3)

        let au = drawTxt(brand, CGPoint(x: lx, y: 166), 34, .bold, .white, -0.6)
        drawSym("checkmark.seal.fill", CGPoint(x: lx + au.width + 10, y: 171), 28, rgb(92,184,255))
        drawTxt("\\(handle)  ·  Apple & Developer Lab", CGPoint(x: lx, y: 126), 24, .regular, rgb(174,174,178), -0.2)
    }
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    var q: CGFloat = 0.91
    var jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: q])!
    while jpg.count > 1_950_000 && q > 0.72 { q -= 0.05; jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: q])! }
    try! jpg.write(to: URL(fileURLWithPath: job.outPath))
}
`;
