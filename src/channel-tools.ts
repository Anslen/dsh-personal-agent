// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tool } from "../modules/superagent/src/app/tools/tool.ts";
import { readHistory } from "./qq-history.ts";
import { send } from "./qq-transport.mjs";
// 发送目的地只从数据库中的已授权入站推导，模型不能传任意QQ号。
export function channelTarget(runtime: any, bot: any, args: any, ticket?: any) {
  const current =
    ticket ||
    (args.task_id ? runtime.store.tickets.get(args.task_id) : undefined);
  if (current?.ended?.by === "human") throw Error("任务已被用户取消");
  const id = current?.origin.triggerId || args.trigger_id;
  const trigger = id && runtime.store.triggers.get(id);
  const address = trigger?.channel?.address;
  if (!trigger?.human || address?.botId !== bot.id)
    throw Error("缺少当前Bot的原始人类会话");
  const allowed =
    address.scope === "c2c"
      ? bot.allowedUsers.includes(address.peerId)
      : bot.allowedGroups.includes(address.peerId);
  if (!allowed) throw Error("原始会话已不在允许名单中");
  return {
    scope: address.scope,
    targetId: address.peerId,
    ...(address.msgId ? { msgId: address.msgId } : {}),
  };
}
export function channelTools(
  runtime: any,
  bot: any,
  stateDir: string,
  ticket?: any,
) {
  const context = {
    task_id: z.string().optional(),
    trigger_id: z.string().optional(),
  };
  const tools = [
    tool({
      name: "qq_history",
      description:
        "读取当前任务或当前人类消息所在QQ群/私聊的本地历史，可按关键词搜索并按时间翻页。先查看历史再回答关于之前聊天的问题。",
      schema: z.object({
        ...context,
        keyword: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        before: z.string().optional(),
      }),
      execute: async (args) => {
        const target = channelTarget(runtime, bot, args, ticket);
        return readHistory(runtime, bot, target.scope, target.targetId, args);
      },
    }),
    tool({
      name: "qq_send_media",
      description:
        "向原始授权QQ会话发送本地文件或媒体。不可用于绕过sticker_send的已审核表情发送流程。主控指定原trigger_id或task_id，执行器固定当前任务。",
      schema: z.object({
        ...context,
        kind: z.enum(["voice", "video", "file"]),
        local_path: z.string(),
      }),
      execute: async (args) => {
        await send(
          bot.id,
          args.kind,
          channelTarget(runtime, bot, args, ticket),
          { localPath: args.local_path },
        );
        return { sent: true };
      },
    }),
  ];
  if (bot.tts)
    tools.push(
      tool({
        name: "qq_voice",
        description:
          "使用部署配置的音色合成并发送中文语音。主控指定原trigger_id或task_id；角色和服务地址由配置固定。",
        schema: z.object({ ...context, text: z.string().min(1).max(120) }),
        execute: async (args, signal) => {
          const target = channelTarget(runtime, bot, args, ticket);
          const apiKey = bot.tts.apiKeyEnv
            ? process.env[bot.tts.apiKeyEnv]
            : undefined;
          if (bot.tts.apiKeyEnv && !apiKey) throw Error("缺少TTS凭据环境变量");
          const response = await fetch(bot.tts.endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
            },
            body: JSON.stringify({
              voice: bot.tts.voice,
              input: args.text,
              response_format: "wav",
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
          });
          if (!response.ok) throw Error("TTS合成失败：" + response.status);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 20 * 1024 * 1024) throw Error("语音文件超过20MB");
          const root = join(stateDir, "tts");
          mkdirSync(root, { recursive: true, mode: 0o700 });
          const file = join(root, randomUUID() + ".wav");
          writeFileSync(file, bytes, { mode: 0o600 });
          await send(bot.id, "voice", target, { localPath: file });
          return { sent: true };
        },
      }),
    );
  return tools;
}
