import test from "node:test";
import assert from "node:assert/strict";
import { Stickers } from "../lib/index.mjs";
test("自主收藏从授权会话消息取图并异步排队，完成后默认静默入库", async () => {
  const values = new Map(),
    relays = [];
  const trigger = {
    human: true,
    channel: { address: { botId: "a", scope: "group", peerId: "group" } },
  };
  const runtime = {
    store: {
      get: (k) => values.get(k),
      set: (k, v) => values.set(k, v),
      keys: (f) => [...values.keys()].filter((k) => k.startsWith(f.prefix)),
      triggers: { get: () => trigger },
      read: { threadPage: () => [] },
    },
    sessions: { relay: (...args) => relays.push(args) },
  };
  values.set("personal:history:group:group", [
    {
      id: "image-message",
      from: "other",
      at: new Date().toISOString(),
      text: "",
      attachments: [{ url: "https://example.com/meme.png" }],
    },
  ]);
  const stickers = new Stickers(
    runtime,
    { id: "a", allowedGroups: ["group"], allowedUsers: [] },
    "/tmp/unused",
  );
  let action, payload;
  stickers.request = async (a, p) => {
    action = a;
    payload = p;
    return { job: { id: "import-job", state: "queued" } };
  };
  const tool = stickers
    .tools({ session: { id: "session" } })
    .find((t) => t.name === "sticker_save");
  const result = await tool.execute(
    tool.schema.parse({ trigger_id: "t", message_id: "image-message" }),
  );
  assert.equal(result.usable, false);
  assert.equal(action, "import");
  assert.equal(payload.payload.imageURL, "https://example.com/meme.png");
  await assert.rejects(
    tool.execute(tool.schema.parse({ trigger_id: "t", message_id: "unknown" })),
  );
  stickers.request = async () => ({
    job: {
      id: "import-job",
      state: "done",
      result: { results: [{ state: "approved", id: "shared:example" }] },
    },
  });
  await stickers.relay();
  assert.equal(relays.length, 0);
  assert.equal(
    [...values.values()].find((x) => x.jobId === "import-job").delivered,
    true,
  );
});
test("同一搜索任务的不同会话订阅分别唤醒主控，持久化去重且取消任务不唤醒", async () => {
  const values = new Map([
      ["personal:sticker:job:a", { jobId: "job", ticketId: "a" }],
      ["personal:sticker:job:b", { jobId: "job", ticketId: "b" }],
      ["personal:sticker:job:c", { jobId: "job", ticketId: "c" }],
    ]),
    relays = [];
  let transactions = 0;
  const runtime = {
    store: {
      keys: (f) => [...values.keys()].filter((k) => k.startsWith(f.prefix)),
      get: (k) => values.get(k),
      set: (k, v) => values.set(k, v),
      atomic: (fn) => {
        transactions++;
        fn();
      },
      tickets: { get: (id) => (id === "c" ? { ended: { by: "human" } } : {}) },
    },
    sessions: { relay: (id, text) => relays.push([id, JSON.parse(text)]) },
  };
  const stickers = new Stickers(runtime, { id: "test" }, "/tmp/unused");
  stickers.request = async () => ({
    job: { id: "job", state: "done", result: { results: [] } },
  });
  await stickers.relay();
  await stickers.relay();
  assert.equal(relays.length, 2);
  assert.notEqual(relays[0][0], relays[1][0]);
  assert.equal(transactions, 2);
  assert.equal(values.get("personal:sticker:job:c").cancelled, true);
  const prior = values.get("personal:sticker:job:a");
  values.set("personal:sticker:job:a", { ...prior, delivered: false });
  stickers.request = async () => ({
    job: {
      id: "job",
      state: "done",
      updated: 2,
      result: { results: [{ id: "fresh", state: "approved" }] },
    },
  });
  await stickers.relay();
  assert.equal(relays.length, 3);
  assert.notEqual(relays[0][0], relays[2][0]);
});
test("运行中的搜索保持等待，最终失败也通过工作流唤醒报告", async () => {
  const value = { jobId: "job", ticketId: "task" },
    relays = [];
  const values = new Map([["personal:sticker:job:task", value]]);
  const runtime = {
    store: {
      keys: () => [...values.keys()],
      get: (k) => values.get(k),
      set: (k, v) => values.set(k, v),
      atomic: (fn) => fn(),
      tickets: { get: () => ({}) },
    },
    sessions: { relay: (id, text) => relays.push(text) },
  };
  const stickers = new Stickers(runtime, { id: "test" }, "/tmp/unused");
  stickers.request = async () => ({ job: { state: "running" } });
  await stickers.relay();
  assert.equal(relays.length, 0);
  stickers.request = async () => ({
    job: { state: "failed", error: "network error" },
  });
  await stickers.relay();
  assert.equal(relays.length, 1);
  assert.equal(JSON.parse(relays[0]).job.error, "network error");
});

test("主控能基于原消息自主搜索并由完成事件唤醒，无需创建执行任务", async () => {
  const values = new Map(),
    relays = [];
  const trigger = {
    human: true,
    channel: {
      address: {
        botId: "auto",
        scope: "c2c",
        peerId: "user",
        msgId: "message",
      },
    },
  };
  const runtime = {
    store: {
      get: (k) => values.get(k),
      set: (k, v) => values.set(k, v),
      keys: (f) => [...values.keys()].filter((k) => k.startsWith(f.prefix)),
      atomic: (fn) => fn(),
      triggers: { get: (id) => (id === "trigger" ? trigger : undefined) },
      tickets: { get: () => undefined },
    },
    sessions: { relay: (id, body) => relays.push(JSON.parse(body)) },
  };
  const stickers = new Stickers(
    runtime,
    { id: "auto", allowedUsers: ["user"], allowedGroups: [] },
    "/tmp/unused",
  );
  stickers.request = async (action) =>
    action === "request"
      ? { job: { id: "job" } }
      : { job: { id: "job", state: "done" } };
  const request = stickers
    .tools({ session: { id: "master" } }, undefined)
    .find((t) => t.name === "sticker_request_search");
  await assert.rejects(() =>
    request.execute({ query: "hi", trigger_id: "wrong" }),
  );
  const result = await request.execute({ query: "hi", trigger_id: "trigger" });
  assert.equal(result.status, "started");
  await stickers.relay();
  await stickers.relay();
  assert.equal(relays.length, 1);
  assert.equal(relays[0].triggerId, "trigger");
});
