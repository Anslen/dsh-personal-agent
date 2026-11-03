import test from "node:test";
import assert from "node:assert/strict";
import { qqSource, qqTrigger } from "../src/qq-source.ts";
import { registerTransport } from "../src/qq-transport.mjs";
test("消息按Bot命名空间映射，私聊是显式请求", () => {
  const m = {
    kind: "c2c",
    senderId: "user",
    messageId: "msg",
    timestamp: new Date().toISOString(),
    content: "hello",
  };
  const a = qqTrigger("a", m),
    b = qqTrigger("b", m);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.threads[0].id, b.threads[0].id);
  assert.equal(a.addressed, "direct");
});
test("Source范围与出站授权保持一致，拒绝跨Bot投递", async () => {
  const kind = qqSource({
    id: "a",
    allowedUsers: ["owner"],
    allowedGroups: ["group"],
  });
  assert.equal(
    kind.scope(
      { meta: { scope: "c2c", senderId: "stranger", peerId: "stranger" } },
      {},
    ).listened,
    false,
  );
  assert.equal(
    kind.scope(
      { meta: { scope: "c2c", senderId: "owner", peerId: "owner" } },
      {},
    ).listened,
    true,
  );
  assert.equal(
    kind.channel.allowed({ botId: "b", scope: "c2c", peerId: "owner" }, {}),
    false,
  );
  await assert.rejects(
    kind.channel.send(
      {},
      { channel: { address: { botId: "b" } }, text: "hello" },
    ),
  );
  const stop = registerTransport("a", {
    sendText: async () => ({ id: "receipt" }),
  });
  assert.equal(
    await kind.channel.send(
      {},
      {
        channel: { address: { botId: "a", scope: "c2c", peerId: "owner" } },
        text: "hello",
      },
    ),
    "sent",
  );
  stop();
});
