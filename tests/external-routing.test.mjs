import test from "node:test";
import assert from "node:assert/strict";
import { registerDriver } from "../src/qq-transport.mjs";
import { handleInbound } from "../modules/qq/dist/transport/inbound.js";
test("旧聚合入站入口也必须转给外部主控，不能创建旧Agent会话", async () => {
  let received;
  const release = registerDriver("external-test", {
    receive: async (message, state) => (received = { message, state }),
  });
  const message = {
    kind: "c2c",
    senderId: "test",
    messageId: "id",
    content: "hi",
  };
  await handleInbound(
    message,
    new Proxy(
      {},
      {
        get() {
          throw Error("禁止读取旧SessionManager");
        },
      },
    ),
    { externalDriver: true, settingsNs: "external-test" },
    console,
    { mention: { wasMentioned: true } },
  );
  assert.equal(received.message, message);
  assert.equal(received.state.mention.wasMentioned, true);
  release();
});
