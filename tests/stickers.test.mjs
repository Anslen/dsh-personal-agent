import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "dsh-sticker-test-"));
process.env.STICKER_PROJECT_ROOT = temp;
for (const r of ["alpha", "beta"]) {
  mkdirSync(join(temp, "roles", r), { recursive: true });
  writeFileSync(join(temp, "roles", r, "AGENTS.md"), r);
}
const configFile = join(temp, "config.json");
writeFileSync(
  configFile,
  JSON.stringify({
    roles: {
      alpha: { personaFile: join(temp, "roles/alpha/AGENTS.md") },
      beta: { personaFile: join(temp, "roles/beta/AGENTS.md") },
    },
  }),
);
process.env.STICKER_CONFIG = configFile;
const {
  library,
  fingerprint,
  search,
  authorizeSend,
  openDB,
  jobsDB,
  enqueue,
  claim,
} = await import("../modules/stickers/store.mjs");
const { publicAddress, imageLinks } = await import(
  "../modules/stickers/network.mjs"
);
const { parseEvents } = await import("../modules/stickers/model.mjs");
const dbs = ["alpha", "beta"].map((r) => library(r));
function put(db, role, id, state = "approved") {
  db.prepare(
    "INSERT INTO assets(id,sha,dhash,source,image_url,path,preview,state,policy,meta,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    id,
    "a",
    "https://example.com",
    "https://example.com/a.png",
    "/tmp/a.png",
    "/tmp/a.jpg",
    state,
    fingerprint(role),
    JSON.stringify({
      tags: ["无语", "晚安"],
      text: "收到",
      description: "可爱猫猫轻微吐槽",
    }),
    Date.now(),
  );
}
put(dbs[0], "alpha", "alpha-only");
put(dbs[1], "beta", "beta-only");
put(dbs[0], "alpha", "unreviewed", "pending");
put(dbs[0], "alpha", "bad", "rejected");
test("角色图库隔离，候选和拒绝图片不可检索", () => {
  assert.deepEqual(
    search(dbs[0], "alpha", "无语", "peer").map((x) => x.id),
    ["alpha-only"],
  );
  assert.deepEqual(
    search(dbs[1], "beta", "无语", "peer").map((x) => x.id),
    ["beta-only"],
  );
});
test("短中文关键词与同义词检索", () => {
  assert.equal(search(dbs[0], "alpha", "无奈", "peer").length, 1);
  assert.equal(search(dbs[0], "alpha", "晚安", "peer").length, 1);
  assert.equal(search(dbs[0], "alpha", "完全不相关", "peer").length, 0);
});
test("发送授权绑定角色和会话，并阻止重复发送", () => {
  const [hit] = search(dbs[0], "alpha", "无语", "peer");
  assert.throws(() =>
    authorizeSend(dbs[1], "beta", hit.id, hit.ticket, "peer"),
  );
  assert.throws(() =>
    authorizeSend(dbs[0], "alpha", hit.id, hit.ticket, "another"),
  );
  assert.equal(
    authorizeSend(dbs[0], "alpha", hit.id, hit.ticket, "peer").id,
    hit.id,
  );
  dbs[0]
    .prepare("INSERT INTO uses VALUES(?,?,?)")
    .run(hit.id, "peer", Date.now());
  assert.throws(
    () => authorizeSend(dbs[0], "alpha", hit.id, hit.ticket, "peer"),
    /最近已发送/,
  );
});
test("人设版本变化立即撤销旧图库准入", () => {
  writeFileSync(join(temp, "roles/alpha/AGENTS.md"), "新的人设");
  assert.equal(search(dbs[0], "alpha", "无语", "peer").length, 0);
});
test("DNS及重定向下载防护拒绝本地和内网地址", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])
    assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress("8.8.8.8"), true);
});
test("网页抽取处理相对地址并排除常见图标", () => {
  assert.deepEqual(
    imageLinks(
      '<img src="/a.png"><img src="/logo.png"><img data-src="https://x.com/b.gif">',
      "https://e.com/p",
    ),
    ["https://e.com/a.png", "https://x.com/b.gif"],
  );
});
test("后台模型必须有实际完成的看图或搜索事件", () => {
  const raw = [
    {
      type: "tool_call",
      tool: "read_image",
      callId: "1",
      input: { file_path: "/a.png" },
    },
    { type: "tool_result", callId: "1", status: "completed" },
    { type: "final", text: '{"approved":true}' },
  ]
    .map(JSON.stringify)
    .join("\n");
  assert.equal(parseEvents(raw, "read_image", "/a.png").approved, true);
  assert.throws(() => parseEvents(raw, "web_search"));
  assert.throws(() => parseEvents(raw, "read_image", "/b.png"));
  assert.throws(() =>
    parseEvents(raw.replace("completed", "failed"), "read_image", "/a.png"),
  );
});
test("持久化队列去重与并发领取", () => {
  const path = join(temp, "jobs.db");
  let db = jobsDB(path);
  const a = enqueue(db, "alpha", "无语");
  assert.equal(enqueue(db, "alpha", "无语").id, a.id);
  assert.notEqual(enqueue(db, "beta", "无语").id, a.id);
  assert.equal(claim(db).id, a.id);
  assert.notEqual(claim(db).id, a.id);
  assert.equal(claim(db), null);
  db.close();
  db = jobsDB(path);
  assert.equal(
    db.prepare("SELECT count(*) n FROM jobs WHERE state='running'").get().n,
    2,
  );
  db.close();
});
// 集成队列使用独立副本，避免测试污染实际调度数据库。
test.after(() => {
  for (const db of dbs) db.close();
  rmSync(temp, { recursive: true, force: true });
});

const { assertViewed } = await import("../modules/stickers/evidence.mjs");
test("发送前必须有本会话实际完成的候选看图记录", () => {
  const now = Date.now(),
    events = [
      {
        type: "tool/call",
        time: now,
        data: {
          name: "read_image",
          callId: "a",
          arguments: '{"file_path":"/preview.jpg"}',
        },
      },
      {
        type: "tool/result",
        time: now,
        data: { message: { toolCallId: "a" } },
      },
    ];
  assert.doesNotThrow(() => assertViewed(events, "/preview.jpg"));
  assert.throws(() => assertViewed(events, "/other.jpg"));
  assert.throws(() => assertViewed([], "/preview.jpg"));
  assert.throws(() => assertViewed(events, "/preview.jpg", now + 400000));
  events[1].data.message.isError = true;
  assert.throws(() => assertViewed(events, "/preview.jpg"));
});

test("来源仅从实际搜索结果提取，忽略模型虚构链接", () => {
  const events = [
    { type: "tool_call", callId: "a", tool: "web_search" },
    {
      type: "tool_result",
      callId: "a",
      status: "completed",
      result: "Sources:\n- [素材](https://example.com/real#1)",
    },
    { type: "final", text: '{"pages":["https://invented.invalid/"]}' },
  ]
    .map(JSON.stringify)
    .join("\n");
  assert.deepEqual(parseEvents(events, "web_search").pages, [
    "https://example.com/real",
  ]);
});

test("同一轮可连续授权发送8张不同表情，不受原每小时6张限制", () => {
  const db = dbs[0],
    peer = "multi-image-test";
  for (let i = 0; i < 8; i++) put(db, "alpha", "multi-" + i);
  const picks = search(db, "alpha", "无语", peer, 20).filter((x) =>
    x.id.startsWith("multi-"),
  );
  assert.equal(picks.length, 8);
  for (const item of picks) {
    assert.equal(
      authorizeSend(db, "alpha", item.id, item.ticket, peer).id,
      item.id,
    );
    db.prepare("INSERT INTO uses VALUES(?,?,?)").run(item.id, peer, Date.now());
  }
});
