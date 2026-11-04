import { createServer } from "node:http";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { resolve, sep, join } from "node:path";
import {
  config,
  HERE,
  roles,
  library,
  jobsDB,
  enqueue,
  roleDir,
  search,
  authorizeSend,
} from "./store.mjs";
import { cancelModels } from "./model.mjs";
import { tick, recover } from "./worker.mjs";

const jobs = jobsDB(),
  libs = new Map(roles.map((r) => [r, library(r)]));
const tokens = new Map(
  roles.map((role) => [
    role,
    readFileSync(join(roleDir(role), ".token"), "utf8").trim(),
  ]),
);
function auth(req) {
  const raw = String(req.headers.authorization || "").replace(/^Bearer /, "");
  for (const [role, key] of tokens)
    if (
      Buffer.byteLength(raw) === Buffer.byteLength(key) &&
      timingSafeEqual(Buffer.from(raw), Buffer.from(key))
    )
      return role;
  throw new Error("认证失败");
}
function inside(file, root) {
  const p = realpathSync(file),
    r = realpathSync(root);
  return p.startsWith(r + sep);
}
export function handle(role, action, args, db = libs.get(role)) {
  const peer = String(args.peer || "");
  if (action === "search")
    return {
      ok: true,
      items: search(
        db,
        role,
        args.query,
        peer,
        Number(args.limit) || 3,
        Array.isArray(args.ids) ? args.ids.slice(0, 20) : [],
      ),
    };
  if (action === "request")
    return { ok: true, job: enqueue(jobs, role, args.query) };
  if (action === "cancel") {
    jobs
      .prepare(
        "UPDATE jobs SET state='cancelled',updated=? WHERE id=? AND role=? AND state IN ('queued','running','retry')",
      )
      .run(Date.now(), String(args.id), role);
    return { ok: true, cancelled: true };
  }
  if (action === "status") {
    const job = args.id
      ? jobs
          .prepare(
            "SELECT id,role,query,state,attempts,result,error,updated FROM jobs WHERE id=? AND role=?",
          )
          .get(args.id, role)
      : null;
    const stats = db
      .prepare("SELECT state,COUNT(*) count FROM assets GROUP BY state")
      .all();
    return {
      ok: true,
      role,
      stats,
      job: job
        ? { ...job, result: job.result ? JSON.parse(job.result) : null }
        : null,
      recent: jobs
        .prepare(
          "SELECT id,query,state,error FROM jobs WHERE role=? ORDER BY created DESC LIMIT 5",
        )
        .all(role),
    };
  }
  if (action === "authorize" || action === "inspect") {
    const row = authorizeSend(
      db,
      role,
      String(args.id || ""),
      args.ticket ? String(args.ticket) : undefined,
      peer,
    );
    if (
      !existsSync(row.path) ||
      !inside(row.path, join(roleDir(role), "files"))
    )
      throw new Error("图片文件不在当前角色的正式图库");
    if (action === "inspect")
      return { ok: true, id: row.id, path: row.path, preview: row.preview };
    // 授权凭据一次性使用；发送失败可以重新检索领取，避免重复并发发送。
    db.prepare("DELETE FROM tickets WHERE token=?").run(row.selectionToken);
    return { ok: true, id: row.id, path: row.path };
  }
  if (action === "sent") {
    const row = db
      .prepare("SELECT id FROM assets WHERE id=? AND state='approved'")
      .get(String(args.id || ""));
    if (!row) throw new Error("图片不存在");
    db.prepare("INSERT INTO uses VALUES(?,?,?)").run(row.id, peer, Date.now());
    db.prepare("UPDATE assets SET used=used+1 WHERE id=?").run(row.id);
    return { ok: true };
  }
  throw new Error("未知操作");
}
const server = createServer(async (req, res) => {
  function reply(status, data) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(data));
  }
  if (req.method === "GET" && req.url === "/health")
    return reply(200, { ok: true, roles });
  try {
    const role = auth(req);
    if (req.method !== "POST")
      return reply(405, { ok: false, error: "仅接受POST" });
    const action = String(req.url).slice(1);
    let text = "";
    for await (const part of req) {
      text += part;
      if (text.length > 10000) throw new Error("请求过大");
    }
    reply(200, handle(role, action, JSON.parse(text || "{}")));
  } catch (e) {
    reply(e.message === "认证失败" ? 401 : 400, {
      ok: false,
      error: e.message,
    });
  }
});
let stopping = false,
  timer;
async function loop() {
  if (stopping) return;
  try {
    await tick(jobs);
  } catch (e) {
    console.error(JSON.stringify({ event: "worker_error", error: e.message }));
  }
  if (!stopping) timer = setTimeout(loop, 3000);
}
recover(jobs);
server.listen(config.port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "ready", port: server.address().port }));
  loop();
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    cancelModels();
    clearTimeout(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
