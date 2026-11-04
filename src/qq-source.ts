import { promptText, renderPrompt } from "../prompts/index.mjs";
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";
import type { SourceKind } from "../modules/superagent/src/sources/kind.ts";
import type { Trigger } from "../modules/superagent/src/core/index.ts";
import { recordHistory } from "./qq-history.ts";
import { send } from "./qq-transport.mjs";

// 每个角色的Runtime单独注册同名Source；Bot身份不由模型传入。
export function qqSource(
  bot: {
    id: string;
    allowedUsers: string[];
    allowedGroups: string[];
  },
  runtime?: any,
): SourceKind {
  return {
    kind: "qq",
    title: { zh: "QQ", en: "QQ" },
    description: {
      zh: promptText("agent/qq-source/zh"),
      en: promptText("agent/qq-source/en"),
    },
    schema: z.record(z.string(), z.unknown()),
    fields: [],
    health: ["qq"],
    scope({ meta }) {
      const allowed =
        meta.scope === "c2c"
          ? bot.allowedUsers.includes(String(meta.senderId))
          : bot.allowedGroups.includes(String(meta.peerId));
      return allowed
        ? { listened: true, observed: false, row: String(meta.peerId) }
        : { listened: false, reason: "not_allowed" };
    },
    policy: {
      schema: z.object({
        allowed: z
          .array(z.object({ id: z.string() }))
          .default(bot.allowedUsers.map((id) => ({ id }))),
      }),
      fields: [],
      explicit: { zh: "私聊或群内提及机器人", en: "Direct message or mention" },
    },
    channel: {
      allowed: (address) =>
        address.botId === bot.id &&
        (address.scope === "c2c"
          ? bot.allowedUsers.includes(address.peerId || "")
          : bot.allowedGroups.includes(address.peerId || "")),
      async send(_host, message) {
        const address = message.channel.address;
        if (address.botId !== bot.id) throw new Error("跨Bot发送被拒绝");
        const receipt = "personal:qq-receipt:" + message.id;
        if (runtime?.store.get(receipt)) return "sent";
        const result = await send(
          bot.id,
          "text",
          {
            scope: address.scope,
            targetId: address.peerId,
            ...(address.msgId ? { msgId: address.msgId } : {}),
            senderId:
              address.senderId ||
              runtime?.store.triggers.get(`qq:${bot.id}:${address.msgId}`)
                ?.actor.id,
          },
          message.text,
        );
        if (runtime)
          recordHistory(runtime, bot, {
            kind: address.scope,
            groupOpenid: address.scope === "group" ? address.peerId : undefined,
            peerId: address.peerId,
            senderId: "self",
            messageId: message.id,
            content: message.text,
            timestamp: new Date().toISOString(),
          });
        if (runtime)
          runtime.store.set(receipt, {
            sentAt: new Date().toISOString(),
            receipt: result,
          });
        return "sent";
      },
      link: () => ({ url: "", label: { zh: "QQ会话", en: "QQ conversation" } }),
    },
    threadContext: {
      messageId: (trigger) => String(trigger.meta.messageId),
      async read(_commands, trigger, _part, cursor) {
        if (!runtime) throw new Error("QQ历史读取器尚未初始化");
        const offset = cursor ? Number(cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new Error("历史游标异常");
        const thread = trigger.threads[0];
        const items = runtime.store.read.threadPage(
          thread.source + ":" + thread.id,
          offset,
          50,
        );
        return {
          messages: items.map((t: any) => ({
            id: String(t.meta.messageId),
            from: t.actor.id,
            at: t.at,
            text: t.text,
          })),
          body: {},
          ...(items.length === 50 ? { next: String(offset + 50) } : {}),
        };
      },
    },
  };
}
export function replyText(reply: any) {
  if (!reply) return "";
  return "\n[回复消息 " + JSON.stringify(reply) + "]";
}
export function qqTrigger(
  botId: string,
  message: any,
  state?: any,
  reply?: any,
  history?: any,
): Trigger {
  const scope = message.kind === "group" ? "group" : "c2c";
  const peerId = scope === "group" ? message.groupOpenid : message.senderId;
  if (!peerId || !message.messageId)
    throw new Error("QQ消息缺少会话或消息标识");
  const thread = `${botId}:${scope}:${peerId}`;
  return {
    id: `qq:${botId}:${message.messageId}`,
    source: "qq",
    threads: [{ source: "qq", id: thread }],
    actor: { source: "qq", id: message.senderId },
    human: true,
    dispatch: "orchestrator",
    ...(scope === "c2c"
      ? { addressed: "direct" as const }
      : state?.mention?.wasMentioned
        ? { addressed: "mention" as const }
        : {}),
    at: message.timestamp,
    text:
      (message.content || "") +
      ((message.attachments || []).length
        ? "\n[用户附带" +
          message.attachments.length +
          "个附件，可用sticker_input_view查看图片参考]"
        : "") +
      replyText(reply) +
      (history
        ? "\n[历史归档状态 " +
          JSON.stringify(history) +
          "；这只是条数与更新时间，需要历史内容时调用qq_history重新查询]"
        : ""),
    channel: {
      source: "qq",
      thread: `qq:${thread}`,
      address: {
        botId,
        scope,
        peerId,
        msgId: message.messageId,
        senderId: message.senderId,
      },
    },
    meta: {
      botId,
      scope,
      peerId,
      senderId: message.senderId,
      messageId: message.messageId,
      attachments: message.attachments || [],
      ...(reply ? { reply } : {}),
      ...(history ? { history } : {}),
    },
  };
}
