import test from "node:test";
import assert from "node:assert/strict";
import { recordHistory, readHistory } from "../src/qq-history.ts";
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
