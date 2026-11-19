import Foundation
import ImageIO
import Vision

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    throw CocoaError(.fileReadCorruptFile)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: image).perform([request])
let width = Double(image.width)
let height = Double(image.height)
let lines = (request.results ?? []).compactMap { observation -> [String: Any]? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let rect = observation.boundingBox
    return [
        "text": candidate.string,
        "box": [Int(rect.minX * width), Int((1 - rect.maxY) * height),
                Int(rect.maxX * width), Int((1 - rect.minY) * height)]
    ]
}
try FileHandle.standardOutput.write(contentsOf: JSONSerialization.data(withJSONObject: lines))
