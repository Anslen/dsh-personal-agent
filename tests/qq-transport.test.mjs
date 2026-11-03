import test from "node:test";
import assert from "node:assert/strict";
import {
  registerDriver,
  registerTransport,
  receive,
  send,
} from "../src/qq-transport.mjs";
test("多Bot入站隔离，驱动未就绪明确失败", async () => {
  const got = [];
  const a = registerDriver("a", { receive: async (x) => got.push(["a", x]) });
  const b = registerDriver("b", { receive: async (x) => got.push(["b", x]) });
  await receive("a", "one");
  await receive("b", "two");
  assert.deepEqual(got, [
    ["a", "one"],
    ["b", "two"],
  ]);
  a();
  await assert.rejects(receive("a", "three"));
  b();
});
test("出站按Bot隔离，错误传播且支持卸载", async () => {
  const stop = registerTransport("a", {
    sendText: async (t, x) => ({ id: "sent", text: x }),
  });
  assert.equal((await send("a", "text", {}, "hello")).id, "sent");
  await assert.rejects(send("b", "text", {}, "hello"));
  await assert.rejects(send("a", "unknown", {}, ""));
  stop();
  await assert.rejects(send("a", "text", {}, "hello"));
});
