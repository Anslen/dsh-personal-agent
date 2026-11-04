import test from "node:test";
import assert from "node:assert/strict";
import { recordHistory, readHistory } from "../src/qq-history.ts";
import { qqTrigger } from "../src/qq-source.ts";
import { archiveAndMentionOnly } from "../src/qq-inbound-policy.mjs";
import { quoteRef } from "@tencent-connect/qqbot-nodejs";
function fixture(id = "one") {
  const data = new Map(),
    bot = { id, allowedGroups: ["group"], allowedUsers: ["user"] };
  return {
    bot,
    runtime: {
      store: {
        get: (k) => data.get(k),
        set: (k, v) => data.set(k, v),
        read: { threadPage: () => [] },
      },
    },
  };
}
test("历史工具按时间、发送人ID或昵称筛选，所有人支持分页，拒绝无时区和倒序范围", async () => {
  const { runtime, bot } = fixture();
  const base = Date.now() - 60000;
  for (let i = 0; i < 4; i++)
    recordHistory(runtime, bot, {
      kind: "group",
      groupOpenid: "group",
      senderId: i % 2 ? "a" : "b",
      senderName: i % 2 ? "甲" : "乙",
      messageId: "m" + i,
      timestamp: new Date(base + i * 1000).toISOString(),
      content: "项目讨论",
    });
  const args = {
    start_time: new Date(base + 1000).toISOString(),
    end_time: new Date(base + 2000).toISOString(),
    sender: "*",
    limit: 1,
  };
  const first = readHistory(runtime, bot, "group", "group", args);
  assert.deepEqual(
    first.messages.map((r) => r.id),
    ["m2"],
  );
  const next = readHistory(runtime, bot, "group", "group", {
    ...args,
    before: first.next_before,
  });
  assert.deepEqual(
    next.messages.map((r) => r.id),
    ["m1"],
  );
  for (const sender of ["a", "甲"])
    assert.deepEqual(
      readHistory(runtime, bot, "group", "group", { sender }).messages.map(
        (r) => r.id,
      ),
      ["m3", "m1"],
    );
  assert.equal(
    readHistory(runtime, bot, "group", "group", { sender: "不存在" }).messages
      .length,
    0,
  );
  assert.throws(() =>
    readHistory(runtime, bot, "group", "group", {
      start_time: "2026-11-04T10:00:00",
    }),
  );
  assert.throws(() =>
    readHistory(runtime, bot, "group", "group", {
      start_time: new Date(base + 3000).toISOString(),
      end_time: new Date(base).toISOString(),
    }),
  );
});

test("普通消息本地归档，引用它的@消息直接携带原文、发送人和附件进入模型", async () => {
  const { runtime, bot } = fixture();
  const quote = quoteRef({ contentLimit: 12000, preferMsgElements: true });
  const gate = archiveAndMentionOnly((message, state) =>
    recordHistory(runtime, bot, message, state),
  );
  let modelCalls = 0;
  let trigger;
  const run = async (message) => {
    const ctx = {
      bot: { appId: "123" },
      message: {
        kind: "group",
        groupOpenid: "group",
        timestamp: new Date().toISOString(),
        senderId: "member",
        ...message,
      },
      state: {},
      log: { debug() {} },
      stop() {},
    };
    await quote(ctx, () =>
      gate(ctx, async () => {
        modelCalls++;
        const row = recordHistory(runtime, bot, ctx.message, ctx.state);
        trigger = qqTrigger(bot.id, ctx.message, ctx.state, row.reply);
      }),
    );
  };
  await run({
    messageId: "original",
    msgIdx: "idx-original",
    content: "明天下午两点开会",
    senderName: "甲",
    attachments: [{ url: "https://example.com/a.jpg" }],
    rawEventType: "GROUP_MESSAGE_CREATE",
  });
  assert.equal(modelCalls, 0);
  await run({
    messageId: "reply",
    refMsgIdx: "idx-original",
    content: "请记下这个安排",
    rawEventType: "GROUP_AT_MESSAGE_CREATE",
  });
  assert.equal(modelCalls, 1);
  assert.equal(trigger.meta.reply.id, "original");
  assert.equal(trigger.meta.reply.from, "member");
  assert.equal(trigger.meta.reply.name, "甲");
  assert.equal(trigger.meta.reply.attachments.length, 1);
  assert.match(trigger.text, /明天下午两点开会/);
  assert.equal(
    readHistory(runtime, bot, "group", "group").messages.find(
      (r) => r.id === "reply",
    ).reply.id,
    "original",
  );
  // 新Runtime视图复用持久化台账，引用解析不依赖SDK进程内缓存。
  const row = recordHistory({ store: runtime.store }, bot, {
    kind: "group",
    groupOpenid: "group",
    senderId: "member",
    messageId: "after-restart",
    refMsgIdx: "idx-original",
  });
  assert.equal(row.reply.text, "明天下午两点开会");
});

test("引用支持平台附带原文，缺失明确标注，并且不读取其他会话", () => {
  const { runtime, bot } = fixture();
  const message = {
    kind: "group",
    groupOpenid: "group",
    senderId: "member",
    messageId: "reply",
    refMsgIdx: "missing",
  };
  let row = recordHistory(runtime, bot, message, {
    quote: {
      source: "msg_elements",
      refKey: "missing",
      rawContent: "平台附带原文",
      attachments: [],
    },
  });
  assert.equal(row.reply.text, "平台附带原文");
  assert.equal(row.reply.available, true);
  row = recordHistory(
    runtime,
    bot,
    { ...message, messageId: "missing2" },
    {
      quote: {
        source: "store",
        text: "其他群的内容",
        entry: {
          peerId: "other-group",
          scope: "group",
          content: "其他群的内容",
        },
      },
    },
  );
  assert.equal(row.reply.available, false);
  assert.equal(row.reply.text, "");
});
test("未触发主控的群消息可独立持久化查询，Bot和会话边界隔离", () => {
  const a = fixture(),
    b = fixture("two");
  recordHistory(a.runtime, a.bot, {
    kind: "group",
    groupOpenid: "group",
    senderId: "member",
    messageId: "m1",
    timestamp: new Date().toISOString(),
    content: "之前说的deadline",
  });
  assert.equal(
    readHistory(a.runtime, a.bot, "group", "group", { keyword: "deadline" })
      .messages.length,
    1,
  );
  assert.equal(
    readHistory(b.runtime, b.bot, "group", "group").messages.length,
    0,
  );
  assert.throws(() => readHistory(a.runtime, a.bot, "group", "other"));
  recordHistory(a.runtime, a.bot, {
    kind: "group",
    groupOpenid: "other",
    messageId: "m2",
    content: "no",
  });
  assert.equal(
    readHistory(a.runtime, a.bot, "group", "group").messages.length,
    1,
  );
});
test("相同时间的记录翻页不遗漏、不重复，重复消息去重", () => {
  const { runtime, bot } = fixture(),
    at = new Date().toISOString();
  for (let i = 0; i < 6; i++)
    recordHistory(runtime, bot, {
      kind: "group",
      groupOpenid: "group",
      senderId: "member",
      messageId: "m" + i,
      timestamp: at,
      content: "hi",
    });
  recordHistory(runtime, bot, {
    kind: "group",
    groupOpenid: "group",
    senderId: "member",
    messageId: "m0",
    timestamp: at,
    content: "updated",
  });
  const found = [];
  let before;
  do {
    const page = readHistory(runtime, bot, "group", "group", {
      limit: 2,
      before,
    });
    found.push(...page.messages);
    before = page.next_before;
  } while (before);
  assert.equal(found.length, 6);
  assert.equal(new Set(found.map((r) => r.id)).size, 6);
});
