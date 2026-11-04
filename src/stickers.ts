// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { channelTarget } from "./channel-tools.ts";
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
      const value = await this.request("status", { id: sub.jobId });
      if (value.job?.state === "cancelled") {
        this.runtime.store.set(key, {
          ...sub,
          delivered: true,
          cancelled: true,
        });
        continue;
      }
      if (!["done", "failed"].includes(value.job?.state)) continue;
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
            event: "sticker_search_finished",
            job: value.job,
            ticketId: sub.ticketId,
            triggerId: sub.triggerId,
            instruction:
              "这是此前任务的异步完成事件。判断是否需要通过orchestrator回复原会话；不要重复搜索。结果中的approved素材已入库；将其id列表传给sticker_search的ids参数，再sticker_view查看并sticker_send发送，避免关键词漏检。",
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
        description: "查询后台表情搜索的当前阶段、候选数量和重试原因。",
        schema: z.object({ id: z.string() }),
        execute: async (args: any) => this.request("status", args),
      }),
      tool({
        name: "sticker_cancel_search",
        description: "用户要求停止时取消后台表情搜索。",
        schema: z.object({ id: z.string(), trigger_id: z.string().optional() }),
        execute: async (args: any) => {
          channelTarget(this.runtime, this.bot, args, ticket);
          return this.request("cancel", args);
        },
      }),
      tool({
        name: "sticker_request_search",
        description:
          "异步联网搜索当前Bot的表情包。立即返回started，完成后通过持久化事件唤醒主控。可主动补库，主控传当前人类消息trigger_id。",
        schema: z.object({
          query: z.string().min(1).max(160),
          trigger_id: z.string().optional(),
        }),
        execute: async (args: any) => {
          channelTarget(this.runtime, this.bot, args, ticket);
          const triggerId = ticket?.origin.triggerId || args.trigger_id;
          const result = await this.request("request", { query: args.query });
          this.runtime.store.set(
            subscriptions(result.job.id + ":" + (ticket?.id || triggerId)),
            {
              jobId: result.job.id,
              ticketId: ticket?.id,
              triggerId,
              delivered: false,
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
        description:
          "检索当前Bot已入库的表情，使用sticker_view查看选中的图片后再发送。",
        schema: z.object({
          query: z.string().default(""),
          ids: z.array(z.string()).max(20).optional(),
          limit: z.number().int().min(1).max(5).default(3),
        }),
        execute: async (args: any) =>
          this.request("search", { ...args, peer: agent.session.id }),
      }),
      tool({
        name: "sticker_input_view",
        description:
          "查看用户消息或其引用原消息中的图片。传原trigger_id和图片序号index（从0开始），source=reply查看引用图片，无需搜索历史。",
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
        description:
          "查看已检索候选的实际图片。返回图片本身，确认合适后用sticker_send发送同一id。",
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
        description:
          "将已用sticker_view查看的表情发送至原QQ会话。只传候选id；主控还需原trigger_id或task_id，检索授权由后台管理。",
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
