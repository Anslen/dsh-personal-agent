import { spawn } from "node:child_process";
import { join } from "node:path";
import { HERE } from "./store.mjs";

export const DSH = process.env.DSH_COMMAND || "dsh";
export function parseJSON(text) {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("模型未返回合法的JSON对象");
  }
}
// 使用官方 CLI 与本机账号，独立 profile 不加载 QQ 插件，避免重复连接 Bot。
export const children = new Set();
export function cancelModels() {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
}
export function parseEvents(text, requiredTool, image) {
  const events = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const error = events.find((e) => e.type === "error");
  if (error) throw new Error(error.message);
  const calls = events.filter(
    (e) =>
      e.type === "tool_call" &&
      e.tool === requiredTool &&
      (!image ||
        (Array.isArray(image)
          ? image.includes(e.input?.file_path)
          : e.input?.file_path === image)),
  );
  const completed = calls.filter((call) =>
    events.some(
      (e) =>
        e.type === "tool_result" &&
        e.callId === call.callId &&
        e.status === "completed",
    ),
  );
  if (!completed.length)
    throw new Error("模型没有完成要求的实际工具调用：" + requiredTool);
  const images = image ? (Array.isArray(image) ? image : [image]) : [];
  for (const path of images)
    if (!completed.some((call) => call.input?.file_path === path))
      throw new Error("模型没有实际读取全部参考图：" + path);
  const final = events.findLast((e) => e.type === "final");
  if (!final) throw new Error("模型没有最终输出");
  const evidence = {
    session: events.find((e) => e.type === "session")?.sessionId,
    tool: requiredTool,
    callIds: completed.map((c) => c.callId),
    images: images.map((path) => ({
      path,
      callIds: completed
        .filter((c) => c.input?.file_path === path)
        .map((c) => c.callId),
    })),
  };
  if (requiredTool === "web_search") {
    // 来源直接提取实际搜索工具输出，避免把模型自行生成的链接当成检索结果。
    const urls = [];
    for (const call of completed) {
      const result = events.find(
        (e) =>
          e.type === "tool_result" &&
          e.callId === call.callId &&
          e.status === "completed",
      );
      for (const match of String(result.result).matchAll(
        /\]\((https:\/\/[^\s)]+)\)/g,
      )) {
        try {
          const u = new URL(match[1]);
          u.hash = "";
          if (!urls.includes(u.href)) urls.push(u.href);
        } catch {}
      }
    }
    const score = (url) => {
      const u = new URL(url);
      return u.hostname === "github.com" &&
        u.pathname.split("/").filter(Boolean).length === 2
        ? 4
        : /\.(png|webp|gif|jpe?g)$/i.test(u.pathname)
          ? 3
          : /duitang|biaoqing|meme/.test(url)
            ? 2
            : 1;
    };
    return {
      pages: urls.sort((a, b) => score(b) - score(a)).slice(0, 8),
      _evidence: evidence,
    };
  }
  return { ...parseJSON(final.text), _evidence: evidence };
}
export async function modelTask(
  prompt,
  { search = false, image, images, timeout = 150000 } = {},
) {
  const patch = join(HERE, search ? "search.patch.yml" : "review.patch.yml");
  return new Promise((resolve, reject) => {
    const child = spawn(
      DSH,
      ["--profile", "headless", "--patch", patch, "--json", "-"],
      {
        cwd: HERE,
        env: { ...process.env, DSH_PERMISSION_MODE: "read-only" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    children.add(child);
    let stdout = "",
      stderr = "",
      settled = false;
    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(result);
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      finish(new Error("模型任务超时"));
    }, timeout);
    child.stdout.on("data", (b) => {
      stdout += b;
      if (stdout.length > 2e6) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        finish(new Error("模型输出过长"));
      }
    });
    child.stderr.on("data", (b) => {
      stderr = (stderr + b).slice(-4000);
    });
    child.on("error", (e) => finish(e));
    child.on("exit", (code) => {
      children.delete(child);
      if (code !== 0)
        return finish(
          new Error(
            `DSH后台调用失败(${code}): ${stderr.replace(/https?:\/\/\S+/g, "[endpoint]").slice(-600)}`,
          ),
        );
      try {
        finish(
          null,
          parseEvents(
            stdout,
            search ? "web_search" : "read_image",
            images || image,
          ),
        );
      } catch (e) {
        finish(e);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}
