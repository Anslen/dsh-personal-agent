import test from "node:test";
import assert from "node:assert/strict";
import { qqSource, qqTrigger } from "../src/qq-source.ts";
import { registerTransport, send } from "../src/qq-transport.mjs";

test("群回复@原请求人，保留正文中其他成员，不重复@，私聊不插入标签", async () => {
  const sent = [];
  const stop = registerTransport("mentions", {
    sendText: async (target, text) => {
      sent.push({ target, text });
      return { id: "sent" };
    },
    sendMarkdown: async (target, text) => {
      sent.push({ target, text, kind: "markdown" });
      return { id: "mention" };
    },
    sendMedia: async (target, kind, content) => {
      sent.push({ target, kind, content });
      return { id: "media" };
    },
  });
  try {
    const source = qqSource({
      id: "mentions",
      allowedGroups: ["group"],
      allowedUsers: ["asker"],
    });
    const message = {
      kind: "group",
      groupOpenid: "group",
      senderId: "asker",
      messageId: "message",
      content: "<@someoneElse> 请回答",
      timestamp: new Date().toISOString(),
    };
    const trigger = qqTrigger("mentions", message, {
      mention: { wasMentioned: true },
    });
    assert.equal(trigger.dispatch, "orchestrator");
    assert.equal(trigger.channel.address.senderId, "asker");
    await source.channel.send(
      {},
      {
        id: "reply",
        channel: trigger.channel,
        text: "<@someoneElse> 这是相关成员的信息。",
      },
    );
    assert.equal(
      sent.at(-1).text,
      "<@asker> <@someoneElse> 这是相关成员的信息。",
    );
    await send(
      "mentions",
      "text",
      { scope: "group", targetId: "group", senderId: "asker" },
      "<@asker> 已收到",
    );
    assert.equal(sent.at(-1).text, "<@asker> 已收到");
    await send(
      "mentions",
      "image",
      { scope: "group", targetId: "group", senderId: "asker" },
      { localPath: "/tmp/image.png" },
    );
    assert.equal(sent.at(-2).kind, "markdown");
    assert.equal(sent.at(-2).text, "<@asker>");
    assert.deepEqual(sent.at(-1).content, { localPath: "/tmp/image.png" });
    await send(
      "mentions",
      "video",
      { scope: "group", targetId: "group", senderId: "asker" },
      { url: "https://example.com/video.mp4", content: "给你看看" },
    );
    assert.equal(sent.at(-2).text, "<@asker> 给你看看");
    assert.deepEqual(sent.at(-1).content, {
      url: "https://example.com/video.mp4",
    });
    const count = sent.length;
    await send(
      "mentions",
      "image",
      { scope: "c2c", targetId: "asker", senderId: "asker" },
      { localPath: "/tmp/image.png", content: "图片说明" },
    );
    assert.equal(sent.length, count + 1);
    assert.deepEqual(sent.at(-1).content, {
      localPath: "/tmp/image.png",
      content: "图片说明",
    });
    await send(
      "mentions",
      "text",
      { scope: "c2c", targetId: "asker", senderId: "asker" },
      "你好",
    );
    assert.equal(sent.at(-1).text, "你好");
  } finally {
    stop();
  }
});
