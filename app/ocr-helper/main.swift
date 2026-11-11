// 会中提词 OCR 助手：常驻进程，stdin 每行一条 JSON 命令，stdout 每行一条 JSON 事件。
// 截取指定窗口（ScreenCaptureKit，窗口被遮挡也能截），用 Vision 做中文识别。
import Foundation
import AppKit
import Vision
import ScreenCaptureKit
import CoreGraphics
import UniformTypeIdentifiers
import ImageIO

setvbuf(stdout, nil, _IOLBF, 0)
let out = FileHandle.standardOutput
let writeLock = NSLock()
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    writeLock.lock(); out.write(data); out.write("\n".data(using: .utf8)!); writeLock.unlock()
}

struct Line { var text: String; var x: Double; var y: Double; var w: Double; var h: Double }

func recognize(_ image: CGImage) throws -> [Line] {
    let req = VNRecognizeTextRequest()
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image).perform([req])
    var items: [Line] = []
    for o in req.results ?? [] {
        guard let c = o.topCandidates(1).first, c.confidence > 0.3 else { continue }
        let b = o.boundingBox // 归一化，原点左下
        items.append(Line(text: c.string, x: b.minX, y: 1 - b.maxY, w: b.width, h: b.height))
    }
    // 自上而下；同一行（纵向中心接近）按 x 合并
    items.sort { $0.y < $1.y }
    var rows: [[Line]] = []
    for it in items {
        if var last = rows.last, let ref = last.first, abs((ref.y + ref.h / 2) - (it.y + it.h / 2)) < min(ref.h, it.h) * 0.5 {
            last.append(it); rows[rows.count - 1] = last
        } else { rows.append([it]) }
    }
    return rows.map { row in
        let s = row.sorted { $0.x < $1.x }
        let minX = s.map { $0.x }.min()!, minY = s.map { $0.y }.min()!
        let maxX = s.map { $0.x + $0.w }.max()!, maxY = s.map { $0.y + $0.h }.max()!
        return Line(text: s.map { $0.text }.joined(separator: " "), x: minX, y: minY, w: maxX - minX, h: maxY - minY)
    }
}

func linesJSON(_ lines: [Line]) -> [[String: Any]] {
    lines.map { ["text": $0.text, "x": $0.x, "y": $0.y, "w": $0.w, "h": $0.h] }
}

let larkNames = ["lark", "feishu", "飞书"]
func isLark(_ app: SCRunningApplication?) -> Bool {
    guard let app else { return false }
    let s = (app.applicationName + " " + app.bundleIdentifier).lowercased()
    return larkNames.contains { s.contains($0) }
}

func shareable() async throws -> SCShareableContent {
    try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
}

// 窗口重开后编号会变：编号找不到时按 标题+应用 找回
func resolve(_ content: SCShareableContent, _ windowId: UInt32, _ title: String?, _ app: String?) -> SCWindow? {
    if let w = content.windows.first(where: { $0.windowID == windowId }) { return w }
    guard let title, !title.isEmpty else { return nil }
    return content.windows.filter { ($0.title ?? "") == title && (app == nil || $0.owningApplication?.applicationName == app) && $0.frame.width > 200 }
        .sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }.first
}

func capture(windowId: UInt32, title: String? = nil, app: String? = nil) async throws -> (CGImage, UInt32) {
    let content = try await shareable()
    guard let win = resolve(content, windowId, title, app) else {
        throw NSError(domain: "ocr", code: 404, userInfo: [NSLocalizedDescriptionKey: "找不到所选飞书窗口，可能已关闭，请重新选择"])
    }
    let filter = SCContentFilter(desktopIndependentWindow: win)
    let cfg = SCStreamConfiguration()
    let scale = Double(filter.pointPixelScale)
    cfg.width = max(1, Int(win.frame.width * scale))
    cfg.height = max(1, Int(win.frame.height * scale))
    cfg.showsCursor = false
    let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    return (img, win.windowID)
}

func crop(_ img: CGImage, _ r: [String: Double]?) -> CGImage {
    guard let r, let x = r["x"], let y = r["y"], let w = r["w"], let h = r["h"], w > 0.01, h > 0.01 else { return img }
    let W = Double(img.width), H = Double(img.height)
    let rect = CGRect(x: x * W, y: y * H, width: w * W, height: h * H).integral
    return img.cropping(to: rect) ?? img
}

func savePNG(_ img: CGImage, _ path: String) throws {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { throw NSError(domain: "ocr", code: 1) }
    CGImageDestinationAddImage(dest, img, nil)
    if !CGImageDestinationFinalize(dest) { throw NSError(domain: "ocr", code: 2) }
}

actor Loop {
    var task: Task<Void, Never>?
    func start(windowId: UInt32, title: String?, app: String?, region: [String: Double]?, intervalMs: Int) {
        task?.cancel()
        task = Task {
            var wid = windowId
            var lastText = ""
            var failures = 0
            while !Task.isCancelled {
                let t0 = Date()
                do {
                    let (img, got) = try await capture(windowId: wid, title: title, app: app)
                    if got != wid { wid = got; emit(["type": "window", "windowId": Int(got)]) }
                    let lines = try recognize(crop(img, region))
                    let joined = lines.map { $0.text }.joined(separator: "\n")
                    let ms = Int(Date().timeIntervalSince(t0) * 1000)
                    failures = 0
                    if joined != lastText {
                        lastText = joined
                        emit(["type": "frame", "at": Date().timeIntervalSince1970 * 1000, "ms": ms, "lines": linesJSON(lines)])
                    } else {
                        emit(["type": "tick", "at": Date().timeIntervalSince1970 * 1000, "ms": ms])
                    }
                } catch {
                    failures += 1
                    emit(["type": "error", "message": error.localizedDescription, "failures": failures])
                    // 不再放弃：窗口最小化、切桌面、重开后都会自动接上；失败多了放慢重试
                    try? await Task.sleep(nanoseconds: UInt64(min(failures, 5)) * 1_000_000_000)
                }
                let spent = Date().timeIntervalSince(t0) * 1000
                let wait = max(150, Double(intervalMs) - spent)
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000))
            }
        }
    }
    func stop() { task?.cancel(); task = nil }
}
let loop = Loop()

func handle(_ cmd: [String: Any]) async {
    let id = cmd["id"] as? String ?? ""
    func reply(_ obj: [String: Any]) { var o = obj; o["type"] = "reply"; o["id"] = id; emit(o) }
    func fail(_ e: Error) { reply(["ok": false, "error": e.localizedDescription]) }
    switch cmd["cmd"] as? String ?? "" {
    case "permission":
        reply(["ok": true, "granted": CGPreflightScreenCaptureAccess()])
    case "request-permission":
        reply(["ok": true, "granted": CGRequestScreenCaptureAccess()])
    case "list":
        do {
            let content = try await shareable()
            let wins = content.windows.filter { isLark($0.owningApplication) && $0.frame.width > 200 && $0.frame.height > 150 }
                .sorted { a, b in
                    func rank(_ w: SCWindow) -> Int { let t = w.title ?? ""; if t.contains("转写") || t.contains("字幕") { return 0 }; if (w.owningApplication?.applicationName ?? "").contains("会议") { return t.isEmpty ? 2 : 1 }; return t.isEmpty ? 4 : 3 }
                    let ra = rank(a), rb = rank(b); if ra != rb { return ra < rb }
                    return a.frame.width * a.frame.height > b.frame.width * b.frame.height }
                .map { w -> [String: Any] in
                    ["windowId": w.windowID, "title": w.title ?? "", "app": w.owningApplication?.applicationName ?? "",
                     "width": w.frame.width, "height": w.frame.height, "onScreen": w.isOnScreen]
                }
            reply(["ok": true, "windows": wins])
        } catch { fail(error) }
    case "snapshot":
        do {
            guard let wid = cmd["windowId"] as? Int, let path = cmd["path"] as? String else { throw NSError(domain: "ocr", code: 400, userInfo: [NSLocalizedDescriptionKey: "参数无效"]) }
            let (img, _) = try await capture(windowId: UInt32(wid), title: cmd["title"] as? String, app: cmd["app"] as? String)
            try savePNG(img, path)
            reply(["ok": true, "width": img.width, "height": img.height])
        } catch { fail(error) }
    case "ocr-once":
        do {
            guard let wid = cmd["windowId"] as? Int else { throw NSError(domain: "ocr", code: 400, userInfo: [NSLocalizedDescriptionKey: "参数无效"]) }
            let t0 = Date()
            let (img, _) = try await capture(windowId: UInt32(wid), title: cmd["title"] as? String, app: cmd["app"] as? String)
            let lines = try recognize(crop(img, cmd["region"] as? [String: Double]))
            reply(["ok": true, "ms": Int(Date().timeIntervalSince(t0) * 1000), "lines": linesJSON(lines)])
        } catch { fail(error) }
    case "ocr-file":
        do {
            guard let path = cmd["path"] as? String, let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
                  let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { throw NSError(domain: "ocr", code: 400, userInfo: [NSLocalizedDescriptionKey: "无法读取图片"]) }
            let t0 = Date()
            let lines = try recognize(crop(img, cmd["region"] as? [String: Double]))
            reply(["ok": true, "ms": Int(Date().timeIntervalSince(t0) * 1000), "lines": linesJSON(lines)])
        } catch { fail(error) }
    case "start":
        guard let wid = cmd["windowId"] as? Int else { reply(["ok": false, "error": "参数无效"]); return }
        await loop.start(windowId: UInt32(wid), title: cmd["title"] as? String, app: cmd["app"] as? String, region: cmd["region"] as? [String: Double], intervalMs: cmd["intervalMs"] as? Int ?? 1200)
        reply(["ok": true])
    case "stop":
        await loop.stop(); reply(["ok": true])
    default:
        reply(["ok": false, "error": "未知命令"])
    }
}

// 预热识别模型（首次加载约十几秒）
Task.detached {
    let t0 = Date()
    let ctx = CGContext(data: nil, width: 400, height: 80, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 400, height: 80))
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    ("预热 识别" as NSString).draw(at: NSPoint(x: 10, y: 20), withAttributes: [.font: NSFont.systemFont(ofSize: 36)])
    if let img = ctx.makeImage() { _ = try? recognize(img) }
    emit(["type": "ready", "warmupMs": Int(Date().timeIntervalSince(t0) * 1000)])
}

DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let cmd = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        Task { await handle(cmd) }
    }
    exit(0)
}
dispatchMain()
