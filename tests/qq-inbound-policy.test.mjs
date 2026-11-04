import test from "node:test";
import assert from "node:assert/strict";
import { archiveAndMentionOnly } from "../src/qq-inbound-policy.mjs";
import { recordHistory, readHistory } from "../src/qq-history.ts";

function fixture(message) {
  const data = new Map();
  const runtime = {
    store: {
      get: (key) => data.get(key),
      set: (key, value) => data.set(key, value),
      read: { threadPage: () => [] },
    },
  };
  const bot = { allowedGroups: ["group"], allowedUsers: ["user"] };
  const ctx = {
    bot: { appId: "123" },
    message: {
      kind: "group",
      groupOpenid: "group",
      senderId: "other-member",
      messageId: "m",
      content: "普通发言",
      ...message,
    },
    // 即使旧策略和扩展要求强制唤醒，普通消息也只记录。
    state: {
      qqInboundForceWake: true,
      policy: { group: { requireMention: false } },
    },
    log: { debug() {} },
    stop(reason) {
      this.stopped = reason;
    },
  };
  return {
    runtime,
    bot,
    ctx,
    gate: archiveAndMentionOnly((m) => recordHistory(runtime, bot, m)),
  };
}

test("其他群员未@消息只归档，不运行后续模型链，强制唤醒不能越过规则", async () => {
  const { runtime, bot, ctx, gate } = fixture({
    rawEventType: "GROUP_MESSAGE_CREATE",
  });
  let modelCalls = 0;
  await gate(ctx, async () => modelCalls++);
  assert.equal(modelCalls, 0);
  assert.equal(ctx.stopped, "mention-gate:no_mention");
  assert.equal(readHistory(runtime, bot, "group", "group").messages.length, 1);
});

test("两类群事件中的明确@均归档后进入模型链，@其他人不触发", async () => {
  for (const [message, expected] of [
    [{ rawEventType: "GROUP_AT_MESSAGE_CREATE" }, 1],
    [{ rawEventType: "GROUP_MESSAGE_CREATE", mentions: [{ is_you: true }] }, 1],
    [{ content: "<@123> 你好" }, 1],
    [{ content: "<@!123> 你好" }, 1],
    [{ mentions: [{ is_you: false }], content: "<@456> 你好" }, 0],
  ]) {
    const { runtime, bot, ctx, gate } = fixture(message);
    let calls = 0;
    await gate(ctx, async () => {
      assert.equal(
        readHistory(runtime, bot, "group", "group").messages.length,
        1,
      );
      calls++;
    });
    assert.equal(calls, expected);
  }
});

test("私聊仍然正常进入模型链", async () => {
  const { ctx, gate } = fixture({
    kind: "c2c",
    groupOpenid: undefined,
    senderId: "user",
  });
  let calls = 0;
  await gate(ctx, async () => calls++);
  assert.equal(calls, 1);
});
