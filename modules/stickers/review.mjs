import { promptText, renderPrompt } from "../../prompts/index.mjs";
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";
import { modelTask } from "./model.mjs";
import { analyze, comparisonBoard } from "./analyze.mjs";
export const REVIEW_VERSION = 4;
export const reviewSchema = z.object({
  approved: z.boolean(),
  text: z.string().max(2000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  description: z.string().max(600).optional(),
  reason: z.string().max(300).optional(),
});
export function referencesOf(role) {
  if (role.mode === "search") return [];
  const images = role.referenceImages;
  if (
    !Array.isArray(images) ||
    images.length < 2 ||
    images.length > 6 ||
    new Set(images).size !== images.length
  )
    throw Error("角色审核需要2至6张不同参考图");
  return images;
}
export function approvedReview(result) {
  return result.approved;
}
export async function assess(role, preview, query = "") {
  const references = referencesOf(role),
    script = await analyze(preview, references),
    board = await comparisonBoard(preview, references);
  // 脚本已完成文字、标签和对比信息整理，模型只读取一张合成对照图并复核采纳。
  const reviewed = await modelTask(
    renderPrompt("stickers/review/reviewed", {
      p0: JSON.stringify(board),
      p1: JSON.stringify(query),
      p2: JSON.stringify(
        role.mode === "search"
          ? promptText("stickers/review/p2")
          : role.identityDescription || promptText("stickers/review/p2.2"),
      ),
      p3: JSON.stringify(script),
      p4: role.mode === "search" ? "" : promptText("stickers/review/p4"),
      p5: role.sharedDirectory ? promptText("stickers/review/p5") : "",
    }),
    { image: board, timeout: 60000 },
  );
  const checked = reviewSchema.parse(reviewed);
  if (
    role.sharedDirectory &&
    checked.approved &&
    (!checked.tags?.some((tag) => tag.trim()) || !checked.description?.trim())
  )
    throw Error(promptText("stickers/review/assess"));
  const result = {
    ...script,
    ...checked,
    tags: checked.tags?.length
      ? checked.tags
      : script.tags.length
        ? script.tags
        : ["表情"],
    description:
      checked.description ||
      script.text ||
      promptText("stickers/review/description"),
    reason: checked.reason || (checked.approved ? "采纳" : "未采纳"),
  };
  return { result, evidence: { ...reviewed._evidence, script, board } };
}
