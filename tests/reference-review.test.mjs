import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "dsh-reference-review-"));
const persona = join(root, "persona.md"),
  a = join(root, "a.png"),
  b = join(root, "b.png"),
  config = join(root, "config.json");
writeFileSync(persona, "通用测试角色");
writeFileSync(a, "reference-a");
writeFileSync(b, "reference-b");
const role = { personaFile: persona, referenceImages: [a, b] };
writeFileSync(config, JSON.stringify({ roles: { test: role } }));
process.env.STICKER_CONFIG = config;
process.env.STICKER_PROJECT_ROOT = root;
const { fingerprint } = await import("../modules/stickers/store.mjs");
const { parseEvents } = await import("../modules/stickers/model.mjs");
const { approvedReview, referencesOf } = await import(
  "../modules/stickers/review.mjs"
);
test("复核以模型采纳决定为准，允许简短结果", async () => {
  const { reviewSchema } = await import("../modules/stickers/review.mjs");
  assert.deepEqual(reviewSchema.parse({ approved: true }), { approved: true });
  assert.equal(approvedReview({ approved: true }), true);
  assert.equal(approvedReview({ approved: false }), false);
});
test("候选和全部参考图均须实际读取成功", () => {
  const events = [];
  const read = (path, id, status = "completed") =>
    events.push(
      {
        type: "tool_call",
        tool: "read_image",
        callId: id,
        input: { file_path: path },
      },
      { type: "tool_result", callId: id, status },
    );
  read("/candidate.png", "c");
  read(a, "a");
  events.push({ type: "final", text: "{}" });
  assert.throws(
    () =>
      parseEvents(events.map(JSON.stringify).join("\n"), "read_image", [
        "/candidate.png",
        a,
        b,
      ]),
    /全部参考图/,
  );
  read(b, "b", "failed");
  assert.throws(
    () =>
      parseEvents(events.map(JSON.stringify).join("\n"), "read_image", [
        "/candidate.png",
        a,
        b,
      ]),
    /全部参考图/,
  );
  read(b, "b-ok");
  const result = parseEvents(
    events.map(JSON.stringify).join("\n"),
    "read_image",
    ["/candidate.png", a, b],
  );
  assert.equal(result._evidence.images.length, 3);
});
test("同路径参考图片内容变化立即使旧审核指纹失效", () => {
  const before = fingerprint("test");
  writeFileSync(a, "reference-a-revised");
  assert.notEqual(fingerprint("test"), before);
  assert.throws(() => referencesOf({ ...role, referenceImages: [a] }));
  assert.throws(() => referencesOf({ ...role, referenceImages: [a, a] }));
});
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

test("专用看图工具只有实际返回图片后才能作为发送证据", async () => {
  const { assertViewed } = await import("../modules/stickers/evidence.mjs");
  const now = Date.now();
  const events = [
    {
      type: "tool/call",
      time: now,
      data: {
        name: "sticker_view",
        callId: "view-one",
        arguments: '{"id":"one"}',
      },
    },
    {
      type: "tool/result",
      time: now,
      data: { message: { toolCallId: "view-one", content: [] } },
    },
  ];
  assert.throws(() => assertViewed(events, "/unused", now, "one"));
  events[1].data.message.content.push({
    type: "image",
    attachment: { attachmentId: "actual-image" },
  });
  assert.doesNotThrow(() => assertViewed(events, "/unused", now, "one"));
  assert.throws(() => assertViewed(events, "/unused", now, "another"));
});

test("聊天工具说明变化不会触发整库重复复核", () => {
  const before = fingerprint("test");
  writeFileSync(persona, "更新聊天工具使用说明");
  assert.equal(fingerprint("test"), before);
});
