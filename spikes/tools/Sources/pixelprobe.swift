// 读取 PNG 指定像素的 RGBA（用于验证窗口截图角像素 alpha=0 → 真透明）
// 用法：swiftc -O -o bin/pixelprobe Sources/pixelprobe.swift && ./bin/pixelprobe shot.png 2 2
import AppKit
import Foundation
let args = CommandLine.arguments
guard args.count >= 4, let img = NSImage(contentsOfFile: args[1]),
      let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else {
    print("LOAD_FAIL"); exit(1)
}
let x = Int(args[2]) ?? 0, y = Int(args[3]) ?? 0
print("image=\(rep.pixelsWide)x\(rep.pixelsHigh) hasAlpha=\(rep.hasAlpha)")
if let c = rep.colorAt(x: x, y: y) {
    print(String(format: "pixel(%d,%d) r=%.3f g=%.3f b=%.3f a=%.3f", x, y, c.redComponent, c.greenComponent, c.blueComponent, c.alphaComponent))
} else { print("PIXEL_OUT_OF_BOUNDS") }
