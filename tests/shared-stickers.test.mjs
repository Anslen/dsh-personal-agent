import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const root = mkdtempSync(join(tmpdir(), "shared-stickers-"));
const shared = join(root, "shared");
const configPath = join(root, "config.json");
const roles = {
  alpha: { mode: "search", queries: [] },
  beta: { mode: "search", queries: [] },
  shared: { mode: "search", queries: [], sharedDirectory: shared },
};
writeFileSync(
  configPath,
  JSON.stringify({ roles, workerEnabled: false, port: 0 }),
);
process.env.STICKER_PROJECT_ROOT = root;
process.env.STICKER_CONFIG = configPath;
const { library, fingerprint, jobsDB, enqueueImport } = await import(
  "../modules/stickers/store.mjs"
);
const { tick } = await import("../modules/stickers/worker.mjs");
for (const id of ["alpha", "beta"]) {
  mkdirSync(join(root, "roles", id, "stickers"), { recursive: true });
  writeFileSync(join(root, "roles", id, "stickers", ".token"), "key-" + id);
}
function insert(role, id, state) {
  const db = library(role);
  const dir =
    role === "shared" ? shared : join(root, "roles", role, "stickers");
  const file = join(dir, "files", id + ".png"),
    preview = join(dir, "previews", id + ".jpg");
  writeFileSync(file, "test-image");
  writeFileSync(preview, "test-preview");
  db.prepare(
    "INSERT INTO assets(id,sha,dhash,source,image_url,path,preview,state,policy,meta,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    id,
    "0",
    "qq:test",
    "https://example.com/a.png",
    file,
    preview,
    state,
    fingerprint(role),
    JSON.stringify({
      tags: ["开心"],
      description: "测试表情",
      evidence: { tool: "read_image" },
    }),
    Date.now(),
  );
  db.close();
}
insert("alpha", "private", "approved");
insert("shared", "common", "approved");
insert("shared", "pending", "pending");
insert("shared", "rejected", "rejected");
test("两Bot共享正式图库，未入库素材不可检索发送，角色库隔离且发送授权绑定Bot", async (t) => {
  const child = spawn(
    process.execPath,
    [resolve("modules/stickers/server.mjs")],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(async () => {
    child.kill("SIGTERM");
    await once(child, "exit");
    rmSync(root, { recursive: true, force: true });
  });
  let data = "";
  const ready = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(Error("server timeout")), 10000);
    child.once("error", rej);
    child.stdout.on("data", (b) => {
      data += b;
      for (const line of data.split("\n")) {
        try {
          const e = JSON.parse(line);
          if (e.event === "ready") {
            clearTimeout(timer);
            res(e);
          }
        } catch {}
      }
    });
  });
  const request = async (bot, action, args) => {
    const res = await fetch(`http://127.0.0.1:${ready.port}/${action}`, {
      method: "POST",
      headers: { authorization: "Bearer key-" + bot },
      body: JSON.stringify(args),
    });
    return { status: res.status, ...(await res.json()) };
  };
  const a = await request("alpha", "search", {
    query: "开心",
    peer: "same",
    limit: 5,
  });
  assert.deepEqual(a.items.map((i) => i.id).sort(), [
    "private",
    "shared:common",
  ]);
  const b = await request("beta", "search", {
    query: "开心",
    peer: "different",
  });
  assert.deepEqual(
    b.items.map((i) => i.id),
    ["shared:common"],
  );
  assert.equal(
    (
      await request("beta", "inspect", {
        id: "shared:pending",
        peer: "different",
      })
    ).ok,
    false,
  );
  // 两Bot即使使用相同会话字符串，也不能借用另一个Bot的检索授权。
  assert.equal(
    (await request("beta", "inspect", { id: "shared:common", peer: "same" }))
      .ok,
    false,
  );
  assert.equal(
    (await request("alpha", "inspect", { id: "shared:common", peer: "same" }))
      .ok,
    true,
  );
  assert.equal(
    (
      await request("beta", "search", {
        ids: ["shared:common"],
        query: "",
        peer: "different",
      })
    ).items[0].id,
    "shared:common",
  );
  const job = await request("alpha", "import", {
    payload: {
      imageURL: "https://example.com/new.png",
      source: "qq:test:message",
      query: "觉得适合聊天",
    },
  });
  assert.equal(job.job.state, "queued");
  const queued = await request("alpha", "status", { id: job.job.id });
  assert.equal(queued.job.state, "queued");
  assert.equal(
    (
      await request("alpha", "search", {
        query: "开心",
        peer: "same",
        library: "shared",
      })
    ).items.length,
    1,
  );
  const db = jobsDB();
  const done = await tick(db, async () => ({
    results: [{ state: "rejected", id: "not-adopted" }],
    counts: { rejected: 1 },
  }));
  assert.equal(done, true);
  assert.equal(
    db.prepare("select state from jobs where id=?").get(job.job.id).state,
    "done",
  );
  const dedup = enqueueImport(db, "shared", {
    imageURL: "https://example.com/new.png",
    source: "qq:test:message",
    query: "same",
  });
  assert.equal(dedup.id, job.job.id);
  db.close();
});
