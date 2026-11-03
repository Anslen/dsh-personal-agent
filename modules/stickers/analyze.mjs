// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import sharp from "sharp";
import { ROOT, HERE } from "./store.mjs";
const exec = promisify(execFile);
let native;
async function nativeVision() {
  const source = join(HERE, "vision.swift"),
    hash = createHash("sha256")
      .update(readFileSync(source))
      .digest("hex")
      .slice(0, 16),
    dir = join(ROOT, ".tools");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const binary = join(dir, "vision-" + hash);
  if (!existsSync(binary))
    await exec(
      "/usr/bin/swiftc",
      ["-module-cache-path", join(dir, "swift-cache"), source, "-o", binary],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
  return binary;
}
export function keywordTags(text) {
  const groups = [
    ["开心", "高兴", "哈哈", "笑"],
    ["晚安", "睡觉", "困"],
    ["收到", "明白", "好的"],
    ["无语", "离谱", "吐槽"],
    ["吃饭", "饿", "白饭"],
    ["加油", "鼓励"],
    ["生气", "愤怒"],
    ["工作", "上班", "加班"],
  ];
  return groups
    .filter((group) => group.some((word) => text.includes(word)))
    .map((group) => group[0]);
}
export async function analyze(preview, references) {
  const meta = await sharp(preview).metadata();
  let value;
  if (process.platform === "darwin") {
    native ??= nativeVision().catch((error) => {
      native = undefined;
      throw error;
    });
    const binary = await native;
    value = JSON.parse(
      (
        await exec(binary, [preview, ...references], {
          timeout: 20000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout,
    );
  } else {
    // 其他平台使用部署提供的本地OCR命令，缺少时明确报错。
    const { stdout } = await exec(
      process.env.STICKER_OCR_COMMAND || "tesseract",
      [preview, "stdout", "-l", "chi_sim+eng"],
      { timeout: 20000, maxBuffer: 1024 * 1024 },
    );
    value = { text: stdout.trim(), referenceDistances: [] };
  }
  return {
    ...value,
    tags: keywordTags(value.text),
    candidateSize: { width: meta.width, height: meta.height },
  };
}
export async function comparisonBoard(preview, references) {
  const inputs = [preview, ...references],
    hash = createHash("sha256");
  for (const path of inputs) hash.update(readFileSync(path));
  const dir = join(ROOT, ".analysis");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, hash.digest("hex") + ".jpg");
  if (!existsSync(path)) {
    const tile = 480,
      columns = Math.min(3, inputs.length),
      rows = Math.ceil(inputs.length / columns);
    const pictures = await Promise.all(
      inputs.map(async (file, i) => ({
        input: await sharp(file)
          .resize(tile, tile, { fit: "contain", background: "#fff" })
          .flatten({ background: "#fff" })
          .jpeg()
          .toBuffer(),
        left: (i % columns) * tile,
        top: Math.floor(i / columns) * tile,
      })),
    );
    await sharp({
      create: {
        width: columns * tile,
        height: rows * tile,
        channels: 3,
        background: "#fff",
      },
    })
      .composite(pictures)
      .jpeg({ quality: 88 })
      .toFile(path);
  }
  return path;
}
