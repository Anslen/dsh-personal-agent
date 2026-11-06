import test from "node:test";
import assert from "node:assert/strict";
// 与插件启动顺序一致，先装配编排运行时，再加载附加渠道工具。
import "../modules/superagent/src/app/runtime.ts";
import { channelTools } from "../src/channel-tools.ts";
import { registerTransport } from "../src/qq-transport.mjs";

test("普通本地图片允许以image发送，群聊走图片通道，file附件语义保持独立", async () => {
  const sent = [];
  const bot = {
    id: "local-image-test",
    allowedUsers: [],
    allowedGroups: ["group"],
  };
  const runtime = {
    store: {
      triggers: {
        get: () => ({
          human: true,
          actor: { id: "requester" },
          channel: {
            address: {
              botId: bot.id,
              scope: "group",
              peerId: "group",
              msgId: "request",
            },
          },
        }),
      },
    },
  };
  const tool = channelTools(runtime, bot, "/tmp/media-test").find(
    (tool) => tool.name === "qq_send_media",
  );
  const stop = registerTransport(bot.id, {
    sendMarkdown: async (target, text) => {
      sent.push({ type: "mention", target, text });
      return { id: "mention" };
    },
    sendMedia: async (target, kind, content) => {
      sent.push({ type: "media", target, kind, content });
      return { id: "media" };
    },
  });
  try {
    const args = tool.schema.parse({
      kind: "image",
      local_path: "/tmp/generated.png",
      trigger_id: "request",
    });
    assert.deepEqual(await tool.execute(args, new AbortController().signal), {
      sent: true,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "image");
    assert.deepEqual(sent[0].content, { localPath: "/tmp/generated.png" });
    assert.equal(sent[0].target.scope, "group");
    await tool.execute(
      tool.schema.parse({
        kind: "file",
        local_path: "/tmp/report.pdf",
        trigger_id: "request",
      }),
      new AbortController().signal,
    );
    assert.equal(sent.at(-1).kind, "file");
    assert.deepEqual(sent.at(-1).content, { localPath: "/tmp/report.pdf" });
  } finally {
    stop();
  }
});
