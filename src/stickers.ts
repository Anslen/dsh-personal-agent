// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
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
      intervalHours: 24,
      maxCandidates: 6,
      maxAttempts: 3,
      roles: {
        [this.bot.id]: {
          name: this.bot.id,
          queries: this.bot.stickers.queries,
          preferred: this.bot.stickers.preferred || [],
          avoid: this.bot.stickers.avoid || [],
          seedSources: this.bot.stickers.sources || [],
          personaFile: this.bot.personaFile,
          referenceImage: this.bot.stickers.referenceImage,
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
      const ticket = this.runtime.store.tickets.get(sub.ticketId);
      if (!ticket || ticket.ended?.by === "human") {
        this.runtime.store.set(key, {
          ...sub,
          delivered: true,
          cancelled: true,
        });
        continue;
      }
      const value = await this.request("status", { id: sub.jobId });
      if (!["done", "failed"].includes(value.job?.state)) continue;
      // 与原型Effects共用事务；relay会唤醒主控，notify仅注入，不能代替relay。
      this.runtime.store.atomic(() => {
        this.runtime.sessions.relay(
          "sticker:" + sub.jobId + ":" + sub.ticketId,
          JSON.stringify({
            event: "sticker_search_finished",
            job: value.job,
            ticketId: sub.ticketId,
            instruction:
              "这是此前任务的异步完成事件。判断是否需要通过orchestrator回复原会话；不要重复搜索。需要发图先使用sticker_search和read_image查看，然后sticker_send。",
          }),
        );
        this.runtime.store.set(key, { ...sub, delivered: true });
      });
    }
  }
  tools(agent: any, ticket: any) {
    return [
      tool({
        name: "sticker_request_search",
        description:
          "异步联网搜索当前Bot的表情包。立即返回started，完成后通过持久化事件唤醒主控；无需轮询。",
        schema: z.object({ query: z.string().min(1).max(160) }),
        execute: async (args: any) => {
          if (!ticket)
            throw new Error(
              "请先将用户请求路由为授权任务，再由任务执行器发起搜索",
            );
          const result = await this.request("request", { query: args.query });
          this.runtime.store.set(
            subscriptions(result.job.id + ":" + ticket.id),
            {
              jobId: result.job.id,
              ticketId: ticket.id,
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
          "检索当前Bot已审核的表情，使用read_image查看preview后再发送。",
        schema: z.object({
          query: z.string(),
          limit: z.number().int().min(1).max(5).default(3),
        }),
        execute: async (args: any) =>
          this.request("search", { ...args, peer: agent.session.id }),
      }),
      tool({
        name: "sticker_send",
        description: "将已经查看的表情发送至当前任务原QQ会话。",
        schema: z.object({
          id: z.string(),
          ticket: z.string(),
          viewed: z.literal(true),
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
          assertViewed(agent.session.snapshotEvents(), picked.preview);
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
