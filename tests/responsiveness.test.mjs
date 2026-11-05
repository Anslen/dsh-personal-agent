import test from "node:test";
import assert from "node:assert/strict";
import {
  bindResponsiveness,
  firstReplyGuard,
  firstReplyKey,
} from "../src/responsiveness.ts";
import { qqSource } from "../src/qq-source.ts";
import { registerTransport } from "../src/qq-transport.mjs";

test("QQ发送失败不释放评估，成功及重试回执可恢复首条回应状态", async () => {
  const kv = new Map(),
    responded = [];
  let fail = true,
    sends = 0;
  const stop = registerTransport("receipt-test", {
    sendText: async () => {
      sends++;
      if (fail) throw Error("暂时断线");
      return { id: "sent" };
    },
  });
  const runtime = {
    store: {
      get: (id) => kv.get(id),
      set: (id, value) => kv.set(id, value),
      triggers: { get: () => ({ human: true, actor: { id: "user" } }) },
    },
    engine: { chatResponded: (id) => responded.push(id) },
    pump: async () => {},
  };
  const source = qqSource(
    { id: "receipt-test", allowedUsers: ["user"], allowedGroups: [] },
    runtime,
  );
  const message = {
    id: "reply",
    channel: {
      address: {
        botId: "receipt-test",
        scope: "c2c",
        peerId: "user",
        msgId: "request",
      },
    },
    text: "我来查一下",
  };
  try {
    await assert.rejects(source.channel.send({}, message), /暂时断线/);
    assert.equal(responded.length, 0);
    assert.equal(kv.get(firstReplyKey("qq:receipt-test:request")), undefined);
    fail = false;
    await source.channel.send({}, message);
    assert.equal(kv.get(firstReplyKey("qq:receipt-test:request")), true);
    kv.delete(firstReplyKey("qq:receipt-test:request"));
    await source.channel.send({}, message);
    assert.equal(kv.get(firstReplyKey("qq:receipt-test:request")), true);
    assert.equal(sends, 2);
    assert.deepEqual(responded, [
      "qq:receipt-test:request",
      "qq:receipt-test:request",
    ]);
  } finally {
    stop();
  }
});

test("主控先自然回应再执行工具，仍可自主建后台任务，回应后历史查询保持可用", () => {
  const kv = new Map();
  let delivered = true;
  const runtime = {
    store: {
      threads: {
        active: () => [{ evaluating: { delivered, triggerIds: ["a"] } }],
      },
      triggers: { get: () => ({ human: true, dispatch: "orchestrator" }) },
      get: (id) => kv.get(id),
    },
  };
  assert.match(firstReplyGuard(runtime, "qq_history", {}), /a/);
  assert.match(firstReplyGuard(runtime, "sticker_input_view", {}), /首条回应/);
  assert.equal(
    firstReplyGuard(runtime, "orchestrator_reply", { trigger_id: "a" }),
    undefined,
  );
  assert.equal(
    firstReplyGuard(runtime, "orchestrator_route", {
      decisions: [{ trigger_id: "a", kind: "accept" }],
    }),
    undefined,
  );
  assert.match(
    firstReplyGuard(runtime, "orchestrator_route", {
      decisions: [{ trigger_id: "a", kind: "ignore" }],
    }),
    /a/,
  );
  kv.set(firstReplyKey("a"), true);
  assert.equal(firstReplyGuard(runtime, "qq_history", {}), undefined);
  assert.equal(firstReplyGuard(runtime, "bash", {}), undefined);
  kv.clear();
  delivered = false;
  assert.equal(firstReplyGuard(runtime, "qq_history", {}), undefined);
});

test("部署配置固定每次实际请求为low，主控和执行器均不继承宿主high", async () => {
  for (const id of ["main", "worker"]) {
    let request, guard, section;
    let disposed = 0;
    const agent = {
      id,
      ctx: {
        systemPrompt: {
          section: (value) => {
            section = value;
            return () => disposed++;
          },
        },
        tools: {
          guard: (fn) => {
            guard = fn;
            return () => disposed++;
          },
        },
        on: (name, fn) => {
          assert.equal(name, "agent/request");
          request = fn;
          return () => disposed++;
        },
      },
    };
    const release = bindResponsiveness(
      agent,
      () => ({ masterId: "main", store: { threads: { active: () => [] } } }),
      "low",
    );
    assert.equal(guard({ name: "qq_history", arguments: {} }), undefined);
    assert.equal(section.text(), "");
    for (let i = 0; i < 2; i++)
      assert.deepEqual(
        await request({}, async () => ({
          provider: "deepseek-account",
          model: "deepseek-flash",
          reasoningEffort: "high",
        })),
        {
          provider: "deepseek-account",
          model: "deepseek-flash",
          reasoningEffort: "low",
        },
      );
    release();
    assert.equal(disposed, 3);
  }
});
