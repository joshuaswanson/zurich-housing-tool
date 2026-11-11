// Renders the icon tile and the house mark, each with its own drop shadow,
// into the PNG sizes of a macOS .iconset folder.
import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 4,
      let tile = NSImage(contentsOfFile: arguments[1]),
      let mark = NSImage(contentsOfFile: arguments[2])
else {
    FileHandle.standardError.write(Data("usage: make-icon <tile svg> <mark svg> <iconset>\n".utf8))
    exit(1)
}

func draw(_ image: NSImage, size: CGFloat, opacity: CGFloat, blur: CGFloat, drop: CGFloat) {
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(opacity)
    shadow.shadowBlurRadius = size * blur
    shadow.shadowOffset = NSSize(width: 0, height: -size * drop)
    shadow.set()
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
}

let iconset = URL(fileURLWithPath: arguments[3])
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = points * scale
        let size = CGFloat(pixels)
        let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        draw(tile, size: size, opacity: 0.3, blur: 0.025, drop: 0.01)
        draw(mark, size: size, opacity: 0.22, blur: 0.02, drop: 0.012)
        NSGraphicsContext.restoreGraphicsState()
        let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: iconset.appendingPathComponent(name))
    }
}
