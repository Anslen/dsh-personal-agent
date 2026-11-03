import test from "node:test";
import assert from "node:assert/strict";
import { Stickers } from "../lib/index.mjs";
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
