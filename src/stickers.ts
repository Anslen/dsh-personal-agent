import { promptText, renderPrompt } from "../prompts/index.mjs";
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { channelTarget } from "./channel-tools.ts";
import { readHistory } from "./qq-history.ts";
import { family } from "../modules/superagent/src/kv.ts";
import { tool } from "../modules/superagent/src/app/tools/tool.ts";
import { packageRoot } from "../modules/superagent/src/infra/paths.ts";
const subscriptions = family<any, [string]>("personal:sticker:");
export class Stickers {
  private endpoint = "";
  private key = "";
  private child: any;
  private timer: any;
  private restartTimer: any;
  private stopped = false;
  private failures = 0;
  private relaying = false;
  constructor(
    private runtime: any,
    private bot: any,
    private stateDir: string,
    private attachments?: any,
    private sharedDirectory?: string,
  ) {}
  async start() {
    const root = join(this.stateDir, "media");
    mkdirSync(join(root, "roles", this.bot.id, "stickers"), {
      recursive: true,
      mode: 0o700,
    });
    const token = join(root, "roles", this.bot.id, "stickers", ".token");
    if (!existsSync(token))
      writeFileSync(token, randomBytes(32).toString("hex"), { mode: 0o600 });
    this.key = readFileSync(token, "utf8").trim();
    const config = {
      port: 0,
      intervalHours: this.bot.stickers.intervalHours ?? 24,
      maxCandidates: this.bot.stickers.maxCandidates ?? 6,
      maxAttempts: this.bot.stickers.maxAttempts ?? 3,
      roles: {
        ...(this.sharedDirectory
          ? {
              shared: {
                mode: "search",
                queries: [],
                seedSources: [],
                referenceImages: [],
                sharedDirectory: this.sharedDirectory,
              },
            }
          : {}),
        [this.bot.id]: {
          name: this.bot.id,
          mode: this.bot.stickers.mode,
          queries: this.bot.stickers.queries,
          seedSources: this.bot.stickers.sources || [],
          personaFile: this.bot.personaFile,
          referenceImages: this.bot.stickers.referenceImages,
          identityDescription: this.bot.stickers.identityDescription,
        },
      },
    };
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    const entry = fileURLToPath(
      new URL("../modules/stickers/server.mjs", import.meta.url),
    );
    this.stopped = false;
    this.child = spawn(process.execPath, [entry], {
      env: { ...process.env, STICKER_PROJECT_ROOT: root, STICKER_CONFIG: path },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      const timeout = setTimeout(
        () => reject(new Error("表情服务启动超时")),
        30000,
      );
      this.child.once("error", (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
      this.child.once("exit", (code: number) => {
        this.endpoint = "";
        if (!this.stopped) this.scheduleRestart();
        clearTimeout(timeout);
        reject(new Error("表情服务退出：" + code));
      });
      this.child.stdout.on("data", (b: Buffer) => {
        buffer += b;
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          try {
            const value = JSON.parse(line);
            if (value.event === "ready") {
              this.endpoint = "http://127.0.0.1:" + value.port;
              clearTimeout(timeout);
              resolve();
            }
          } catch {}
        }
      });
    });
    this.timer = setInterval(() => {
      if (this.relaying || !this.endpoint) return;
      this.relaying = true;
      this.relay()
        .catch((e) => console.error("[stickers]", e.message))
        .finally(() => {
          this.relaying = false;
        });
    }, 5000);
  }
  private scheduleRestart() {
    clearInterval(this.timer);
    clearTimeout(this.restartTimer);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5));
    console.error("[stickers] 子进程退出，将在" + delay + "ms后重启");
    this.restartTimer = setTimeout(() => {
      if (!this.stopped)
        this.start().catch((error) => {
          console.error("[stickers]", error.message);
          if (!this.stopped) this.scheduleRestart();
        });
    }, delay);
  }
  async request(action: string, args: any) {
    const response = await fetch(this.endpoint + "/" + action, {
      method: "POST",
      headers: {
        authorization: "Bearer " + this.key,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000),
    });
    const result = (await response.json()) as any;
    if (!response.ok || !result.ok)
      throw new Error(result.error || "表情服务错误");
    return result;
  }
  async relay() {
    for (const key of this.runtime.store.keys(subscriptions)) {
      const sub = this.runtime.store.get(key);
      if (sub.delivered) continue;
      const ticket = sub.ticketId
        ? this.runtime.store.tickets.get(sub.ticketId)
        : undefined;
      const trigger = sub.triggerId
        ? this.runtime.store.triggers.get(sub.triggerId)
        : undefined;
      if (
        (sub.ticketId && (!ticket || ticket.ended?.by === "human")) ||
        (!sub.ticketId && !trigger)
      ) {
        this.runtime.store.set(key, {
          ...sub,
          delivered: true,
          cancelled: true,
        });
        continue;
      }
      const value = await this.request("status", {
        id: sub.jobId,
        ...(sub.library ? { library: sub.library } : {}),
      });
      if (value.job?.state === "cancelled") {
        this.runtime.store.set(key, {
          ...sub,
          delivered: true,
          cancelled: true,
        });
        continue;
      }
      if (!["done", "failed"].includes(value.job?.state)) continue;
      if (sub.silent) {
        // 自主收藏默认静默完成，仅更新共享库，不唤醒聊天或向用户汇报补库进度。
        this.runtime.store.set(key, {
          ...sub,
          delivered: true,
          result: value.job,
        });
        continue;
      }
      // 同一任务恢复搜索后，新的完成结果需要独立投递版本。
      const version =
        value.job.updated ||
        createHash("sha256")
          .update(JSON.stringify(value.job))
          .digest("hex")
          .slice(0, 16);
      // 与原型Effects共用事务；relay会唤醒主控，notify仅注入，不能代替relay。
      this.runtime.store.atomic(() => {
        this.runtime.sessions.relay(
          "sticker:" +
            sub.jobId +
            ":" +
            (sub.ticketId || sub.triggerId) +
            ":" +
            version,
          JSON.stringify({
            event:
              sub.kind === "collection"
                ? "sticker_collection_finished"
                : "sticker_search_finished",
            job: value.job,
            ticketId: sub.ticketId,
            triggerId: sub.triggerId,
            instruction:
              sub.kind === promptText("agent/stickers/instruction")
                ? promptText("agent/stickers/instruction.2")
                : promptText("agent/stickers/instruction.3"),
          }),
        );
        this.runtime.store.set(key, { ...sub, delivered: true });
      });
    }
  }
  tools(agent: any, ticket: any) {
    return [
      tool({
        name: "sticker_status",
        description: promptText("agent/stickers/sticker_status.description"),
        schema: z.object({ id: z.string() }),
        execute: async (args: any) => this.request("status", args),
      }),
      tool({
        name: "sticker_cancel_search",
        description: promptText(
          "agent/stickers/sticker_cancel_search.description",
        ),
        schema: z.object({ id: z.string(), trigger_id: z.string().optional() }),
        execute: async (args: any) => {
          channelTarget(this.runtime, this.bot, args, ticket);
          return this.request("cancel", args);
        },
      }),
      tool({
        name: "sticker_request_search",
        description: promptText(
          "agent/stickers/sticker_request_search.description",
        ),
        schema: z.object({
          query: z.string().min(1).max(160),
          trigger_id: z.string().optional(),
          library: z.enum(["personal", "shared"]).default("personal"),
        }),
        execute: async (args: any) => {
          channelTarget(this.runtime, this.bot, args, ticket);
          const triggerId = ticket?.origin.triggerId || args.trigger_id;
          const result = await this.request("request", {
            query: args.query,
            library: args.library,
          });
          this.runtime.store.set(
            subscriptions(result.job.id + ":" + (ticket?.id || triggerId)),
            {
              jobId: result.job.id,
              ticketId: ticket?.id,
              triggerId,
              delivered: false,
              library: args.library,
            },
          );
          return {
            status: "started",
            jobId: result.job.id,
            completion: "结果会主动投递给主控会话",
          };
        },
      }),
      tool({
        name: "sticker_search",
        description: promptText("agent/stickers/sticker_search.description"),
        schema: z.object({
          query: z.string().default(""),
          ids: z.array(z.string()).max(20).optional(),
          limit: z.number().int().min(1).max(5).default(3),
          library: z
            .enum(["personal", "shared"])
            .optional()
            .describe(promptText("agent/stickers/library")),
        }),
        execute: async (args: any) =>
          this.request("search", { ...args, peer: agent.session.id }),
      }),
      tool({
        name: "sticker_save",
        description: promptText("agent/stickers/sticker_save.description"),
        schema: z.object({
          trigger_id: z.string().optional(),
          message_id: z.string().min(1),
          index: z.number().int().min(0).default(0),
          source: z.enum(["message", "reply"]).default("message"),
          reason: z.string().max(600).default("适合作为聊天表情"),
          notify: z.boolean().default(false),
        }),
        execute: async (args: any) => {
          const target = channelTarget(this.runtime, this.bot, args, ticket);
          const row = readHistory(
            this.runtime,
            this.bot,
            target.scope,
            target.targetId,
            { message_id: args.message_id, limit: 1 },
          ).messages[0];
          if (!row) throw Error("该会话历史中没有此消息");
          const image = (
            args.source === "reply" ? row.reply?.attachments : row.attachments
          )?.[args.index];
          if (!image?.url || !/^https?:\/\//.test(image.url))
            throw Error("消息中没有可收藏的图片");
          const result = await this.request("import", {
            library: "shared",
            payload: {
              imageURL: image.url,
              source:
                "qq:" +
                this.bot.id +
                ":" +
                target.scope +
                ":" +
                target.targetId +
                ":" +
                row.id,
              query: args.reason,
            },
          });
          const triggerId = ticket?.origin.triggerId || args.trigger_id;
          this.runtime.store.set(
            subscriptions(result.job.id + ":" + (ticket?.id || triggerId)),
            {
              jobId: result.job.id,
              ticketId: ticket?.id,
              triggerId,
              library: "shared",
              silent: !args.notify,
              kind: "collection",
              delivered: false,
            },
          );
          return {
            status: "queued",
            jobId: result.job.id,
            usable: false,
            completion: args.notify
              ? "完成后回到原会话"
              : "完成后静默更新共享库",
          };
        },
      }),
      tool({
        name: "sticker_tag",
        description: promptText("agent/stickers/sticker_tag.description"),
        schema: z.object({
          id: z.string(),
          tags: z.array(z.string().min(1).max(40)).min(1).max(20),
          description: z.string().max(600).optional(),
        }),
        execute: async (args: any) => {
          const item = await this.request("inspect", {
            id: args.id,
            peer: agent.session.id,
          });
          const { assertViewed } = await import(
            "../modules/stickers/evidence.mjs"
          );
          assertViewed(
            agent.session.snapshotEvents(),
            item.preview,
            Date.now(),
            args.id,
          );
          return this.request("tag", args);
        },
      }),
      tool({
        name: "sticker_input_view",
        description: promptText(
          "agent/stickers/sticker_input_view.description",
        ),
        schema: z.object({
          trigger_id: z.string().optional(),
          index: z.number().int().min(0).default(0),
          source: z.enum(["message", "reply"]).default("message"),
        }),
        execute: async (args: any) => {
          channelTarget(this.runtime, this.bot, args, ticket);
          const trigger = this.runtime.store.triggers.get(
            ticket?.origin.triggerId || args.trigger_id,
          );
          const input = (
            args.source === "reply"
              ? trigger.meta.reply?.attachments
              : trigger.meta.attachments
          )?.[args.index];
          if (!input || !/^https?:\/\//.test(input.url || ""))
            throw Error("该消息没有可读取的参考图片");
          const { download } = await import("../modules/stickers/network.mjs");
          const { body } = await download(input.url);
          const { default: sharp } = await import("sharp");
          const data = await sharp(body, { limitInputPixels: 20000000 })
            .resize(1280, 1280, { fit: "inside", withoutEnlargement: true })
            .jpeg()
            .toBuffer();
          const image = await this.attachments.saveImage({
            data,
            mediaType: "image/jpeg",
            name: "user-reference.jpg",
          });
          return { image };
        },
      }),
      tool({
        name: "sticker_view",
        description: promptText("agent/stickers/sticker_view.description"),
        schema: z.object({ id: z.string() }),
        execute: async (args: any) => {
          const item = await this.request("inspect", {
            id: args.id,
            peer: agent.session.id,
          });
          const image = await this.attachments.saveImage({
            data: readFileSync(item.preview),
            mediaType: "image/jpeg",
            name: args.id + ".jpg",
          });
          return { id: args.id, image };
        },
      }),
      tool({
        name: "sticker_send",
        description: promptText("agent/stickers/sticker_send.description"),
        schema: z.object({
          id: z.string(),
          task_id: z.string().optional(),
          trigger_id: z.string().optional(),
        }),
        execute: async (args: any) => {
          const target = channelTarget(this.runtime, this.bot, args, ticket);
          const picked = await this.request("inspect", {
            ...args,
            peer: agent.session.id,
          });
          const { assertViewed } = await import(
            "../modules/stickers/evidence.mjs"
          );
          assertViewed(
            agent.session.snapshotEvents(),
            picked.preview,
            Date.now(),
            args.id,
          );
          const approved = await this.request("authorize", {
            ...args,
            peer: agent.session.id,
          });
          const { send } = await import("./qq-transport.mjs");
          await send(this.bot.id, "image", target, {
            localPath: approved.path,
          });
          await this.request("sent", { id: args.id, peer: agent.session.id });
          return { sent: true };
        },
      }),
    ];
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    clearInterval(this.timer);
    this.child?.kill("SIGTERM");
  }
}
