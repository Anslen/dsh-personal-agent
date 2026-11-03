// SPDX-License-Identifier: GPL-3.0-or-later
// 在本机一次完成文字提取和参考图特征距离计算。
import Foundation
import ImageIO
import Vision

let paths = Array(CommandLine.arguments.dropFirst())
guard let first = paths.first else { fatalError("需要图片路径") }
func feature(_ path: String) throws -> VNFeaturePrintObservation {
  let request = VNGenerateImageFeaturePrintRequest()
  try VNImageRequestHandler(url: URL(fileURLWithPath: path)).perform([request])
  guard let result = request.results?.first as? VNFeaturePrintObservation else {
    throw NSError(domain: "vision", code: 1)
  }
  return result
}
do {
  let ocr = VNRecognizeTextRequest()
  ocr.recognitionLevel = .accurate
  ocr.recognitionLanguages = ["zh-Hans", "en-US"]
  ocr.usesLanguageCorrection = false
  try VNImageRequestHandler(url: URL(fileURLWithPath: first)).perform([ocr])
  let lines = (ocr.results ?? []).compactMap { $0.topCandidates(1).first }.filter {
    $0.confidence >= 0.4
  }.map { $0.string }
  let candidate = try feature(first)
  let distances = try paths.dropFirst().map { path -> [String: Any] in
    var distance: Float = 0
    try candidate.computeDistance(&distance, to: feature(path))
    return ["path": path, "distance": distance]
  }
  let result: [String: Any] = [
    "text": lines.joined(separator: " "), "referenceDistances": distances,
  ]
  let data = try JSONSerialization.data(withJSONObject: result)
  print(String(decoding: data, as: UTF8.self))
} catch {
  FileHandle.standardError.write(Data("本地视觉分析失败：\(error)\n".utf8))
  exit(1)
}
