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
export async function assess(role, preview) {
  const references = referencesOf(role),
    script = await analyze(preview, references),
    board = await comparisonBoard(preview, references);
  // 脚本已完成文字、标签和对比信息整理，模型只读取一张合成对照图并复核采纳。
  const reviewed = await modelTask(
    `用read_image查看对照图 ${JSON.stringify(board)}：按从左到右、从上到下，第一格是候选，其余各格是角色参考。角色视觉描述：${JSON.stringify(role.identityDescription || "以参考图识别角色")}。脚本结果：${JSON.stringify(script)}。特征距离仅是视觉相似性线索。复核脚本结果是否准确并决定是否采纳入库；角色素材须与参考身份一致，通用素材是否采纳由你判断。仅返回最简JSON {"approved":true或false}；需要修正脚本文案或标签时再附text、tags。`,
    { image: board, timeout: 60000 },
  );
  const checked = reviewSchema.parse(reviewed);
  const result = {
    ...script,
    ...checked,
    tags: checked.tags?.length
      ? checked.tags
      : script.tags.length
        ? script.tags
        : ["表情"],
    description: checked.description || script.text || "表情素材",
    reason: checked.reason || (checked.approved ? "采纳" : "未采纳"),
  };
  return { result, evidence: { ...reviewed._evidence, script, board } };
}
