import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const HERE = fileURLToPath(new URL(".", import.meta.url));
export const ROOT = process.env.STICKER_PROJECT_ROOT || resolve(HERE, "..");
export const config = JSON.parse(
  readFileSync(process.env.STICKER_CONFIG || join(HERE, "config.json"), "utf8"),
);
export const roles = Object.keys(config.roles);
export function assertRole(role) {
  if (!roles.includes(role)) throw new Error("未知角色");
  return role;
}
export function roleDir(role) {
  if (config.roles[assertRole(role)].sharedDirectory)
    return resolve(config.roles[role].sharedDirectory);
  return join(ROOT, "roles", assertRole(role), "stickers");
}
export function fingerprint(role) {
  const identity = config.roles[assertRole(role)];
  // 审核只依赖视觉身份和参考内容；聊天工具说明的修改不触发整库复核。
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...(identity.mode === "search" ? { mode: "search" } : {}),
        identityDescription: identity.identityDescription || "",
        references: (identity.referenceImages || []).map((path) =>
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ),
      }),
    )
    .update("review-v4")
    .digest("hex");
}

export function openDB(path) {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  return db;
}
export function library(role) {
  const dir = roleDir(role);
  for (const d of ["files", "previews", "quarantine"])
    mkdirSync(join(dir, d), { recursive: true, mode: 0o700 });
  const db = openDB(join(dir, "library.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS assets(
    id TEXT PRIMARY KEY, sha TEXT UNIQUE NOT NULL, dhash TEXT NOT NULL, source TEXT NOT NULL,
    image_url TEXT NOT NULL, path TEXT NOT NULL, preview TEXT NOT NULL, state TEXT NOT NULL,
    policy TEXT NOT NULL, meta TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS review_history(id TEXT,policy TEXT,meta TEXT,at INTEGER);
    CREATE TABLE IF NOT EXISTS uses(id TEXT, peer TEXT, at INTEGER);
    CREATE TABLE IF NOT EXISTS source_cursors(url TEXT PRIMARY KEY, cursor INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS tickets(token TEXT PRIMARY KEY, id TEXT, peer TEXT, expires INTEGER);`);
  return db;
}
export function jobsDB(path = join(ROOT, "jobs.db")) {
  const db = openDB(path);
  db.exec(`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, role TEXT NOT NULL, query TEXT NOT NULL,
    dedup TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER DEFAULT 0, available INTEGER NOT NULL,
    created INTEGER NOT NULL, updated INTEGER NOT NULL, result TEXT, error TEXT);
    CREATE INDEX IF NOT EXISTS pending_jobs ON jobs(state,available);
    CREATE TABLE IF NOT EXISTS schedule(role TEXT PRIMARY KEY, next_run INTEGER NOT NULL, cursor INTEGER DEFAULT 0);`);
  const columns = db
    .prepare("PRAGMA table_info(jobs)")
    .all()
    .map((r) => r.name);
  if (!columns.includes("kind"))
    db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'search'");
  if (!columns.includes("payload"))
    db.exec("ALTER TABLE jobs ADD COLUMN payload TEXT");
  return db;
}
// 会话图片只排队，后台完成看图和打标前不会出现在正式检索中。
export function enqueueImport(db, role, payload) {
  assertRole(role);
  const dedup = createHash("sha256")
    .update(JSON.stringify([role, payload.source, payload.imageURL]))
    .digest("hex");
  const prior = db
    .prepare(
      "SELECT id,state FROM jobs WHERE dedup=? AND kind='import' AND state NOT IN ('failed','cancelled') ORDER BY created DESC LIMIT 1",
    )
    .get(dedup);
  if (prior) return { ...prior, deduplicated: true };
  const id = randomUUID(),
    now = Date.now();
  db.prepare(
    "INSERT INTO jobs(id,role,query,dedup,state,available,created,updated,kind,payload) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    role,
    String(payload.query || "收藏会话表情"),
    dedup,
    "queued",
    now,
    now,
    now,
    "import",
    JSON.stringify(payload),
  );
  return { id, state: "queued" };
}
export function enqueue(db, role, query) {
  assertRole(role);
  query = String(query || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!query || query.length > 160) throw new Error("关键词需要1至160字");
  const dedup = createHash("sha256")
    .update(role + "\0" + query)
    .digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    const prior = db
      .prepare(
        "SELECT * FROM jobs WHERE dedup=? AND (state IN ('queued','running','retry') OR (state='done' AND updated>?)) ORDER BY created DESC LIMIT 1",
      )
      .get(dedup, Date.now() - 60000);
    if (prior) {
      db.exec("COMMIT");
      return { id: prior.id, state: prior.state, deduplicated: true };
    }
    const id = randomUUID(),
      now = Date.now();
    db.prepare(
      "INSERT INTO jobs(id,role,query,dedup,state,available,created,updated) VALUES(?,?,?,?,?,?,?,?)",
    ).run(id, role, query, dedup, "queued", now, now, now);
    db.exec("COMMIT");
    return { id, state: "queued" };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function claim(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(
        "SELECT * FROM jobs WHERE state IN ('queued','retry') AND available<=? ORDER BY created LIMIT 1",
      )
      .get(Date.now());
    if (row)
      db.prepare(
        "UPDATE jobs SET state='running',attempts=attempts+1,updated=? WHERE id=?",
      ).run(Date.now(), row.id);
    db.exec("COMMIT");
    return row ? { ...row, attempts: row.attempts + 1 } : null;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
const synonyms = [
  ["无语", "无奈", "沉默", "吐槽"],
  ["开心", "高兴", "快乐", "欢呼"],
  ["收到", "明白", "确认", "好的"],
  ["晚安", "睡觉", "困"],
  ["安慰", "鼓励", "加油"],
  ["委屈", "难过", "伤心"],
];
export function search(db, role, query, peer, limit = 3, ids = []) {
  const words = String(query || "")
    .trim()
    .split(/[\s,，、]+/)
    .filter(Boolean);
  if (!words.length && !ids.length) throw new Error("需要搜索关键词或素材id");
  const expanded = new Set(words);
  for (const group of synonyms)
    if (group.some((w) => words.some((q) => q.includes(w))))
      for (const w of group) expanded.add(w);
  const items = db
    .prepare("SELECT * FROM assets WHERE state='approved' AND policy=?")
    .all(fingerprint(role));
  const scored = items
    .filter((it) => !ids.length || ids.includes(it.id))
    .map((it) => {
      const m = JSON.parse(it.meta);
      const tags = (m.tags || []).join(" "),
        txt = [tags, m.text, m.description, m.intent, m.emotion].join(" ");
      let score = ids.length ? 1 : 0;
      for (const w of expanded)
        if (txt.includes(w)) score += words.includes(w) ? 4 : 1;
      if (words.some((w) => tags.includes(w))) score += 2;
      return { ...it, meta: m, score };
    })
    .filter((it) => it.score > 0)
    .sort((a, b) => b.score - a.score || a.used - b.used)
    .slice(0, Math.min(20, Math.max(1, limit)));
  const now = Date.now();
  db.prepare("DELETE FROM tickets WHERE expires<?").run(now);
  return scored.map((it) => {
    const token = randomUUID();
    db.prepare("INSERT INTO tickets VALUES(?,?,?,?)").run(
      token,
      it.id,
      peer,
      now + 300000,
    );
    return {
      id: it.id,
      path: it.path,
      preview: it.preview,
      tags: it.meta.tags,
      text: it.meta.text,
      description: it.meta.description,
      score: it.score,
    };
  });
}
export function authorizeSend(db, role, id, ticket, peer) {
  const row = db
    .prepare(
      "SELECT a.*,t.token AS selectionToken FROM assets a JOIN tickets t ON a.id=t.id WHERE a.id=? AND (? IS NULL OR t.token=?) AND t.peer=? AND t.expires>? AND a.state='approved' AND a.policy=? ORDER BY t.expires DESC LIMIT 1",
    )
    .get(
      id,
      ticket ?? null,
      ticket ?? null,
      peer,
      Date.now(),
      fingerprint(role),
    );
  if (!row) throw new Error("请重新检索当前图库后再选择图片发送");
  if (
    db
      .prepare("SELECT 1 FROM uses WHERE id=? AND peer=? AND at>?")
      .get(id, peer, Date.now() - 30 * 60000)
  )
    throw new Error("当前会话最近已发送这张表情");
  return row;
}
