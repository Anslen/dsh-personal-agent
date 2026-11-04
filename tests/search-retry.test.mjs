import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = mkdtempSync(join(tmpdir(), "sticker-retry-"));
process.env.STICKER_PROJECT_ROOT = root;
process.env.STICKER_CONFIG = join(root, "config.json");
writeFileSync(
  process.env.STICKER_CONFIG,
  JSON.stringify({
    intervalHours: 24,
    maxCandidates: 6,
    maxAttempts: 1,
    roles: { test: { queries: ["hello"], mode: "search" } },
  }),
);
const { jobsDB, enqueue } = await import("../modules/stickers/store.mjs");
const { tick } = await import("../modules/stickers/worker.mjs");
test("重复或拒绝候选继续搜索，超过旧重试次数的网络失败仍保留任务，拿到图片后完成", async () => {
  const db = jobsDB();
  const job = enqueue(db, "test", "hello");
  await tick(db, async () => ({
    counts: { duplicate: 6 },
    results: [],
    errors: [],
  }));
  assert.equal(
    db.prepare("select state from jobs where id=?").get(job.id).state,
    "retry",
  );
  db.prepare("update jobs set available=0 where id=?").run(job.id);
  await tick(db, async () => {
    throw Error("HTTP 403");
  });
  assert.equal(
    db.prepare("select state from jobs where id=?").get(job.id).state,
    "retry",
  );
  db.prepare("update jobs set available=0 where id=?").run(job.id);
  await tick(db, async () => ({
    counts: { approved: 1 },
    results: [{ id: "new", state: "approved" }],
    errors: [],
  }));
  const done = db
    .prepare("select state,result from jobs where id=?")
    .get(job.id);
  assert.equal(done.state, "done");
  assert.equal(JSON.parse(done.result).results[0].id, "new");
  db.close();
});
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
