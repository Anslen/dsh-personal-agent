// SPDX-License-Identifier: GPL-3.0-or-later
import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { resolve, join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { Runtime } from "../modules/superagent/src/app/runtime.ts";
import { Store } from "../modules/superagent/src/app/store.ts";
import { Stickers } from "./stickers.ts";
import * as qqPlugin from "../modules/qq/dist/index.js";
import { qqSource, qqTrigger } from "./qq-source.ts";
import { registerDriver } from "./qq-transport.mjs";

import { bindExecution, routeSubprocess } from "./execution-scope.ts";
import { sameOrigin } from "../modules/superagent/src/app/http.ts";
import { Inbox } from "./inbox.ts";
import { channelTools } from "./channel-tools.ts";
import { stickerPolicy, historyPolicy, taskPolicy } from "./sticker-policy.ts";
import { recordHistory, readHistory } from "./qq-history.ts";
export const name = "dsh-personal-agent";
export const inject = [
  "agents",
  "attachments",
  "sessionController",
  "sessionPersistence",
  "workspaceRegistry",
  "permissionPresets",
  "tools",
  "systemPrompt",
  "skills",
  "webServer",
  "llm",
  "subprocess",
];
export const Config = s.object({
  stateDir: s.string().required(),
  sharedStickersEnabled: s.boolean().default(true),
  sharedStickersDirectory: s.string(),
  bots: s
    .array(
      s.object({
        id: s.string().required(),
        connect: s.boolean().default(true),
        appId: s.string().required(),
        secretEnv: s.string().required(),
        personaFile: s.string().required(),
        repository: s.string().required(),
        tts: s.object({
          endpoint: s.string().required(),
          voice: s.string().required(),
          apiKeyEnv: s.string(),
        }),
        stickers: s
          .object({
            intervalHours: s.number().min(1).default(24),
            maxCandidates: s.number().min(1).max(20).default(6),
            maxAttempts: s.number().min(1).max(10).default(3),
            queries: s.array(s.string()).required(),
            sources: s.array(s.string()).default([]),
            mode: s.union(["character", "search"]).default("character"),
            referenceImages: s.array(s.string()).max(6).default([]),
            identityDescription: s.string().default(""),
          })
          .required(),
        allowedUsers: s.array(s.string()).default([]),
        allowedGroups: s.array(s.string()).default([]),
      }),
    )
    .required(),
});
export async function apply(ctx: Context, config: any) {
  ctx.effect(() => routeSubprocess(ctx.subprocess));
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: "/personal-agent/bots",
      handler: async (req: any, res: any) => {
        if (req.method !== "GET" || !sameOrigin(req, ctx.webServer.port)) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ bots: config.bots.map((bot: any) => bot.id) }),
        );
      },
    }),
  );
  const ids = new Set<string>(),
    apps = new Set<string>();
  for (const bot of config.bots) {
    if (bot.id === "shared") throw Error("shared是保留的图库标识");
    if (
      !/^[a-z][a-z0-9-]*$/.test(bot.id) ||
      ids.has(bot.id) ||
      apps.has(bot.appId)
    )
      throw new Error("Bot标识和AppID必须唯一");
    ids.add(bot.id);
    apps.add(bot.appId);
  }
  for (const bot of config.bots) {
    if (
      bot.stickers.mode !== "search" &&
      bot.stickers.referenceImages.length < 2
    )
      throw Error("角色模式需要至少两张参考图");
    const secret = process.env[bot.secretEnv];
    if (!secret) throw new Error(`缺少Bot凭据环境变量：${bot.secretEnv}`);
    const stateDir = resolve(config.stateDir, bot.id);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // 独立数据库、主会话和工作目录，共用DSH宿主及模型服务。
    const seed = new Store(join(stateDir, "orchestrator.sqlite"), (error) =>
      ctx.logger.warn(String(error)),
    );
    if (!Object.keys(seed.settings().sources).length)
      seed.saveSettings({
        ...seed.settings(),
        sources: {
          github: {
            enabled: false,
            config: { repository: bot.repository, cli: "gh" },
          },
          qq: { enabled: true, config: {} },
        },
        policy: {
          ...seed.settings().policy,
          sources: {
            qq: { allowed: bot.allowedUsers.map((id: string) => ({ id })) },
          },
        },
      });
    seed.close();
    const child = ctx.isolate("orchestrator");
    let stickers: Stickers;
    const runtime = new Runtime(
      child,
      {
        stateDir,
        isolatedEnvironment: true,
        bindAgent: (agent: any) =>
          bindExecution(agent, stateDir, process.env.PATH || ""),
        managementPath: `/personal-agent/${bot.id}`,
        extraTools: (agent: any, ticket: any) => [
          ...(stickers?.tools(agent, ticket) || []),
          ...channelTools(runtime, bot, stateDir, ticket),
        ],
        promptMaxChars: { get: () => 100000 },
        admissionContextMaxPages: { get: () => 10 },
        admissionContextTimeoutMs: { get: () => 15000 },
      } as any,
      () => {
        throw new Error("请通过宿主重启此插件");
      },
    );
    ctx.effect(() => () => runtime.stop());
    child.effect(() => runtime.sources.register(qqSource(bot, runtime)));
    const inbox = new Inbox(runtime, (error) =>
      ctx.logger.error(String(error)),
    );
    inbox.start();
    ctx.effect(() => () => inbox.stop());
    child.effect(() =>
      registerDriver(bot.id, {
        observe: (message: any, state: any) =>
          recordHistory(runtime, bot, message, state),
        receive: async (message: any, state: any) => {
          const row = recordHistory(runtime, bot, message, state);
          const scope = message.kind === "group" ? "group" : "c2c";
          const peer =
            message.groupOpenid || message.peerId || message.senderId;
          const { snapshot } = readHistory(runtime, bot, scope, peer, {
            limit: 1,
          });
          await inbox.receive(
            qqTrigger(bot.id, message, state, row?.reply, snapshot),
          );
        },
      }),
    );
    if (bot.connect)
      child.plugin(qqPlugin, {
        appId: bot.appId,
        appSecret: secret,
        settingsNs: bot.id,
        cwd: stateDir,
        dataRoot: stateDir,
        externalDriver: true,
        requireMention: true,
        access: {
          c2cMode: "allowlist",
          c2cAllow: bot.allowedUsers,
          groupMode: "allowlist",
          groupAllow: bot.allowedGroups,
        },
      });
    // 人设是部署配置，不写入通用插件源码。
    const persona = readFileSync(bot.personaFile, "utf8");
    const current = runtime.prompts.current();
    const base = current.config.communication.split(
      "\n\n<!-- deployment-persona -->",
    )[0];
    const communication =
      base +
      "\n\n<!-- deployment-persona -->\n" +
      persona +
      "\n" +
      stickerPolicy +
      "\n" +
      historyPolicy +
      "\n" +
      taskPolicy;
    if (communication !== current.config.communication)
      runtime.prompts.save(
        { ...current.config, communication },
        current.revision,
        "deployment",
      );
    stickers = new Stickers(
      runtime,
      bot,
      stateDir,
      ctx.attachments,
      config.sharedStickersEnabled === false
        ? undefined
        : resolve(
            config.sharedStickersDirectory ||
              join(config.stateDir, "shared", "stickers"),
          ),
    );
    ctx.effect(() => () => stickers.stop());
    await stickers.start();
    await runtime.ready;
    ctx.logger.info(`个人助手 ${bot.id} 已加载，人设长度 ${persona.length}`);
  }
}

export { Stickers };
