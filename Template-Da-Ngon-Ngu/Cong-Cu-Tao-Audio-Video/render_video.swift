import AVFoundation
import CoreGraphics
import CoreText
import Foundation

struct SlideItem: Codable {
    let tag: String
    let vietnamese: String
    let target: String?
    let lao: String?
    let phonetic: String
    let note: String
    let duration: Double
    let reveal_after: Double?
    let audio_path: String?
    let audio_delay: Double?
    let prompt_audio_path: String?
    let prompt_text: String?
    let font_name: String?
    let fallback_font_name: String?
    let font_files: [String]?
    let width: Int?
    let height: Int?

    var targetText: String { target ?? lao ?? "" }
}

private var registeredFontURLs = Set<String>()

func registerCustomFonts(paths: [String]) {
    for rawPath in paths where !rawPath.isEmpty {
        if registeredFontURLs.contains(rawPath) { continue }
        let url = URL(fileURLWithPath: rawPath)
        guard FileManager.default.fileExists(atPath: rawPath) else { continue }
        var err: Unmanaged<CFError>?
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, &err)
        registeredFontURLs.insert(rawPath)
    }
}

func makeFontWithCascade(name: String, fallbackName: String, size: CGFloat) -> CTFont {
    var base = CTFontCreateWithName(name as CFString, size, nil)
    if CTFontCopyPostScriptName(base) as String == "LastResort" {
        base = CTFontCreateWithName(fallbackName as CFString, size, nil)
    }
    let fallbackDesc = CTFontDescriptorCreateWithNameAndSize(fallbackName as CFString, size)
    let cascadeAttrs: [CFString: Any] = [kCTFontCascadeListAttribute: [fallbackDesc] as CFArray]
    let cascadeDesc = CTFontDescriptorCreateWithAttributes(cascadeAttrs as CFDictionary)
    return CTFontCreateCopyWithAttributes(base, size, nil, cascadeDesc)
}

func makeAttributedString(
    _ text: String,
    fontName: String,
    fallbackFontName: String = "HelveticaNeue-Bold",
    size: CGFloat,
    color: CGColor,
    alignment: CTTextAlignment = .center
) -> CFAttributedString {
    let font = makeFontWithCascade(name: fontName, fallbackName: fallbackFontName, size: size)

    var align = alignment
    let setting = withUnsafeBytes(of: &align) { ptr in
        CTParagraphStyleSetting(
            spec: .alignment,
            valueSize: MemoryLayout<CTTextAlignment>.size,
            value: ptr.baseAddress!
        )
    }
    let paragraphStyle = withUnsafePointer(to: setting) { ptr in
        CTParagraphStyleCreate(ptr, 1)
    }

    let attrs: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
        NSAttributedString.Key(kCTParagraphStyleAttributeName as String): paragraphStyle,
    ]
    return CFAttributedStringCreate(kCFAllocatorDefault, text as CFString, attrs as CFDictionary)
}

func drawWrappedText(ctx: CGContext, attrStr: CFAttributedString, rect: CGRect) {
    let framesetter = CTFramesetterCreateWithAttributedString(attrStr)
    let path = CGMutablePath()
    path.addRect(rect)
    let frame = CTFramesetterCreateFrame(framesetter, CFRangeMake(0, 0), path, nil)
    CTFrameDraw(frame, ctx)
}

func renderSlidePixelBuffer(
    slide: SlideItem,
    revealed: Bool,
    width: Int = 1280,
    height: Int = 720
) -> CVPixelBuffer? {
    var maybeBuffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
        kCFAllocatorDefault,
        width,
        height,
        kCVPixelFormatType_32BGRA,
        nil,
        &maybeBuffer
    )
    guard status == kCVReturnSuccess, let pixelBuffer = maybeBuffer else {
        return nil
    }

    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: CVPixelBufferGetBaseAddress(pixelBuffer),
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else {
        return nil
    }

    let w = Double(width)
    let h = Double(height)
    let isPortrait = height > width
    let padX = isPortrait ? 60.0 : 64.0
    let padY = isPortrait ? 90.0 : 56.0

    // Background: warm deep slate
    ctx.setFillColor(CGColor(red: 0.08, green: 0.11, blue: 0.10, alpha: 1.0))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

    // Card surface
    let cardRect = CGRect(x: padX, y: padY, width: w - padX * 2, height: h - padY * 2)
    let cardPath = CGPath(roundedRect: cardRect, cornerWidth: 28, cornerHeight: 28, transform: nil)
    ctx.setFillColor(CGColor(red: 0.12, green: 0.16, blue: 0.14, alpha: 1.0))
    ctx.addPath(cardPath)
    ctx.fillPath()
    ctx.setStrokeColor(CGColor(red: 0.24, green: 0.69, blue: 0.56, alpha: 0.45))
    ctx.setLineWidth(2.5)
    ctx.addPath(cardPath)
    ctx.strokePath()

    let white = CGColor(red: 0.94, green: 0.96, blue: 0.95, alpha: 1.0)
    let teal = CGColor(red: 0.30, green: 0.82, blue: 0.67, alpha: 1.0)
    let amber = CGColor(red: 0.95, green: 0.61, blue: 0.32, alpha: 1.0)
    let muted = CGColor(red: 0.66, green: 0.73, blue: 0.69, alpha: 1.0)

    let innerX = padX + 32.0
    let innerW = w - (padX + 32.0) * 2.0

    let tagStr = makeAttributedString(
        slide.tag,
        fontName: "HelveticaNeue-Bold",
        size: isPortrait ? 28 : 24,
        color: teal
    )
    drawWrappedText(ctx: ctx, attrStr: tagStr, rect: CGRect(x: innerX, y: h * 0.81, width: innerW, height: 54))

    let viSize: CGFloat = slide.vietnamese.count > 65 ? (isPortrait ? 40 : 36) : (isPortrait ? 50 : 44)
    let viStr = makeAttributedString(
        slide.vietnamese,
        fontName: "HelveticaNeue-Bold",
        size: viSize,
        color: white
    )
    drawWrappedText(ctx: ctx, attrStr: viStr, rect: CGRect(x: innerX, y: h * 0.60, width: innerW, height: h * 0.19))

    let targetFont = slide.font_name ?? "NotoSansLao-Bold"
    let fallbackFont = slide.fallback_font_name ?? "HelveticaNeue-Bold"
    let targetText = slide.targetText

    if revealed {
        let targetSize: CGFloat = targetText.count > 35 ? (isPortrait ? 52 : 48) : (isPortrait ? 72 : 66)
        let targetStr = makeAttributedString(
            targetText,
            fontName: targetFont,
            fallbackFontName: fallbackFont,
            size: targetSize,
            color: teal
        )
        drawWrappedText(ctx: ctx, attrStr: targetStr, rect: CGRect(x: innerX, y: h * 0.37, width: innerW, height: h * 0.22))

        if !slide.phonetic.isEmpty {
            let phStr = makeAttributedString(
                slide.phonetic,
                fontName: "HelveticaNeue-Medium",
                size: isPortrait ? 38 : 34,
                color: amber
            )
            drawWrappedText(ctx: ctx, attrStr: phStr, rect: CGRect(x: innerX, y: h * 0.23, width: innerW, height: h * 0.13))
        }

        if !slide.note.isEmpty {
            let noteStr = makeAttributedString(
                slide.note,
                fontName: "HelveticaNeue",
                size: isPortrait ? 26 : 23,
                color: muted
            )
            drawWrappedText(ctx: ctx, attrStr: noteStr, rect: CGRect(x: innerX + 12, y: padY + 24, width: innerW - 24, height: h * 0.11))
        }
    } else {
        let promptMsg = slide.prompt_text ?? "⏱️ Nghe & thử nói to..."
        let promptStr = makeAttributedString(
            promptMsg,
            fontName: "HelveticaNeue-Medium",
            size: isPortrait ? 38 : 34,
            color: amber
        )
        drawWrappedText(ctx: ctx, attrStr: promptStr, rect: CGRect(x: innerX, y: h * 0.35, width: innerW, height: 110))
    }

    return pixelBuffer
}

func renderAudioTrackOnly(slides: [SlideItem], outputPath: String) throws {
    let outURL = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: outURL)

    let comp = AVMutableComposition()
    guard let compAudioTrack = comp.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
        throw NSError(domain: "render_video", code: 8, userInfo: [NSLocalizedDescriptionKey: "Cannot add audio track"])
    }

    var cursorSec: Double = 0
    for slide in slides {
        if let pPath = slide.prompt_audio_path, FileManager.default.fileExists(atPath: pPath) {
            let pAsset = AVURLAsset(url: URL(fileURLWithPath: pPath))
            if let src = pAsset.tracks(withMediaType: .audio).first, pAsset.duration.seconds > 0 {
                let start = CMTime(seconds: cursorSec, preferredTimescale: 600)
                try? compAudioTrack.insertTimeRange(CMTimeRange(start: .zero, duration: pAsset.duration), of: src, at: start)
                cursorSec += pAsset.duration.seconds + 2.2
            }
        }
        if let aPath = slide.audio_path, FileManager.default.fileExists(atPath: aPath) {
            let aAsset = AVURLAsset(url: URL(fileURLWithPath: aPath))
            if let src = aAsset.tracks(withMediaType: .audio).first, aAsset.duration.seconds > 0 {
                let start1 = CMTime(seconds: cursorSec, preferredTimescale: 600)
                try? compAudioTrack.insertTimeRange(CMTimeRange(start: .zero, duration: aAsset.duration), of: src, at: start1)
                cursorSec += aAsset.duration.seconds + 0.8
                let start2 = CMTime(seconds: cursorSec, preferredTimescale: 600)
                try? compAudioTrack.insertTimeRange(CMTimeRange(start: .zero, duration: aAsset.duration), of: src, at: start2)
                cursorSec += aAsset.duration.seconds + 1.0
            }
        }
    }

    guard let exporter = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetAppleM4A) else {
        throw NSError(domain: "render_video", code: 9, userInfo: [NSLocalizedDescriptionKey: "Cannot create M4A exporter"])
    }
    exporter.outputURL = outURL
    exporter.outputFileType = .m4a
    let group = DispatchGroup()
    group.enter()
    exporter.exportAsynchronously { group.leave() }
    group.wait()
    if exporter.status != .completed {
        throw exporter.error ?? NSError(domain: "render_video", code: 10, userInfo: [NSLocalizedDescriptionKey: "M4A export failed"])
    }
}

func renderStoryboard(jsonPath: String, outputPath: String) throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: jsonPath))
    let slides = try JSONDecoder().decode([SlideItem].self, from: data)
    guard !slides.isEmpty else {
        throw NSError(domain: "render_video", code: 1, userInfo: [NSLocalizedDescriptionKey: "Empty storyboard"])
    }

    for slide in slides {
        if let paths = slide.font_files {
            registerCustomFonts(paths: paths)
        }
    }

    if outputPath.lowercased().hasSuffix(".m4a") {
        try renderAudioTrackOnly(slides: slides, outputPath: outputPath)
        return
    }

    let width = slides.first?.width ?? 1280
    let height = slides.first?.height ?? 720
    let fps: Int32 = 2

    let outURL = URL(fileURLWithPath: outputPath)
    let tempVideoURL = outURL.deletingLastPathComponent()
        .appendingPathComponent(".tmp_silent_\(UUID().uuidString).mp4")
    defer { try? FileManager.default.removeItem(at: tempVideoURL) }

    let writer = try AVAssetWriter(outputURL: tempVideoURL, fileType: .mp4)
    let videoSettings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: 1_200_000,
            AVVideoMaxKeyFrameIntervalKey: 4,
        ],
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
    input.expectsMediaDataInRealTime = false

    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: nil
    )

    guard writer.canAdd(input) else {
        throw NSError(domain: "render_video", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot add video input"])
    }
    writer.add(input)
    guard writer.startWriting() else {
        throw writer.error ?? NSError(domain: "render_video", code: 3, userInfo: [NSLocalizedDescriptionKey: "startWriting failed"])
    }
    writer.startSession(atSourceTime: .zero)

    var currentFrame: Int64 = 0
    var appendedFrames: Int64 = 0
    var audioEvents: [(url: URL, startTime: Double)] = []
    var cursorSec: Double = 0

    for slide in slides {
        let totalFrames = max(2, Int(round(slide.duration * Double(fps))))
        let revealSec = slide.reveal_after ?? 0.0
        let revealFrame = revealSec > 0 ? min(totalFrames - 1, max(1, Int(round(revealSec * Double(fps))))) : 0

        if let pPath = slide.prompt_audio_path, FileManager.default.fileExists(atPath: pPath) {
            audioEvents.append((URL(fileURLWithPath: pPath), cursorSec))
        }
        if let aPath = slide.audio_path, FileManager.default.fileExists(atPath: aPath) {
            let delay = slide.audio_delay ?? revealSec
            audioEvents.append((URL(fileURLWithPath: aPath), cursorSec + delay))
        }

        let unrevealedBuf = revealFrame > 0
            ? renderSlidePixelBuffer(slide: slide, revealed: false, width: width, height: height)
            : nil
        let revealedBuf = renderSlidePixelBuffer(slide: slide, revealed: true, width: width, height: height)

        for localIdx in 0..<totalFrames {
            while !input.isReadyForMoreMediaData {
                if writer.status == .failed { break }
                Thread.sleep(forTimeInterval: 0.005)
            }
            if writer.status == .failed { break }
            let buf = (localIdx < revealFrame ? unrevealedBuf : revealedBuf) ?? revealedBuf
            if let b = buf {
                let pts = CMTime(value: currentFrame, timescale: fps)
                if adaptor.append(b, withPresentationTime: pts) {
                    appendedFrames += 1
                }
            }
            currentFrame += 1
        }
        cursorSec += Double(totalFrames) / Double(fps)
    }

    input.markAsFinished()
    let finishGroup = DispatchGroup()
    finishGroup.enter()
    writer.finishWriting { finishGroup.leave() }
    finishGroup.wait()

    if writer.status == .failed, let err = writer.error {
        throw err
    }
    guard appendedFrames > 0 else {
        throw NSError(domain: "render_video", code: 6, userInfo: [NSLocalizedDescriptionKey: "Zero frames appended"])
    }

    try? FileManager.default.removeItem(at: outURL)

    let videoAsset = AVURLAsset(url: tempVideoURL)
    let videoTracks = videoAsset.tracks(withMediaType: .video)
    guard !videoTracks.isEmpty else {
        throw NSError(domain: "render_video", code: 7, userInfo: [NSLocalizedDescriptionKey: "Encoded temp MP4 has no video track (likely H.264 VideoToolbox blocked in restricted sandbox)"])
    }

    if audioEvents.isEmpty {
        try FileManager.default.copyItem(at: tempVideoURL, to: outURL)
        return
    }

    let comp = AVMutableComposition()
    if let srcVideoTrack = videoTracks.first,
       let compVideoTrack = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) {
        try compVideoTrack.insertTimeRange(
            CMTimeRange(start: .zero, duration: videoAsset.duration),
            of: srcVideoTrack,
            at: .zero
        )
    }

    if let compAudioTrack = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
        var cursorAudio = CMTime.zero
        for ev in audioEvents {
            let aAsset = AVURLAsset(url: ev.url)
            if let srcAudio = aAsset.tracks(withMediaType: .audio).first {
                let desiredStart = CMTime(seconds: ev.startTime, preferredTimescale: 600)
                let start = CMTimeMaximum(cursorAudio, desiredStart)
                let dur = aAsset.duration
                if dur.isValid && dur.seconds > 0 {
                    if let _ = try? compAudioTrack.insertTimeRange(CMTimeRange(start: .zero, duration: dur), of: srcAudio, at: start) {
                        cursorAudio = CMTimeAdd(start, dur)
                    }
                }
            }
        }
    }

    guard let exporter = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHighestQuality) else {
        throw NSError(domain: "render_video", code: 4, userInfo: [NSLocalizedDescriptionKey: "Cannot create export session"])
    }
    exporter.outputURL = outURL
    exporter.outputFileType = .mp4

    let exportGroup = DispatchGroup()
    exportGroup.enter()
    exporter.exportAsynchronously { exportGroup.leave() }
    exportGroup.wait()

    if exporter.status != .completed {
        throw exporter.error ?? NSError(domain: "render_video", code: 5, userInfo: [NSLocalizedDescriptionKey: "Export failed with status \(exporter.status.rawValue)"])
    }
}

let args = CommandLine.arguments
if args.count < 3 {
    fputs("Usage: render_video <storyboard.json> <output.mp4>\n", stderr)
    exit(1)
}

do {
    try renderStoryboard(jsonPath: args[1], outputPath: args[2])
    print("OK:", args[2])
} catch {
    fputs("Error: \(error)\n", stderr)
    exit(1)
}
