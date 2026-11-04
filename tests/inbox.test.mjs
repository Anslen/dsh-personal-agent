import test from "node:test";
import assert from "node:assert/strict";
import { Inbox } from "../src/inbox.ts";
import { bindExecution, routeSubprocess } from "../src/execution-scope.ts";
test("模型未就绪时先发确认，新请求不等待旧工作，确认失败可重试且成功后去重", async () => {
  const values = new Map(),
    events = [];
  let ready;
  const runtime = {
    ready: new Promise((resolve) => {
      ready = resolve;
    }),
    store: {
      set: (k, v) => values.set(k, v),
      get: (k) => values.get(k),
      keys: (f) => [...values.keys()].filter((k) => k.startsWith(f.prefix)),
      delete: (k) => values.delete(k),
    },
    receive: (t) => events.push("model:" + t.id),
  };
  let fail = true;
  const inbox = new Inbox(
    runtime,
    () => {},
    async (t) => {
      if (fail) throw Error("network");
      events.push("ack:" + t.id);
    },
  );
  await assert.rejects(inbox.receive({ id: "one" }));
  fail = false;
  const first = inbox.receive({ id: "one" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["ack:one"]);
  await inbox.receive({ id: "two" });
  assert.deepEqual(events, ["ack:one", "ack:two"]);
  ready();
  await first;
  assert.deepEqual(events, ["ack:one", "ack:two", "model:one", "model:two"]);
  await inbox.receive({ id: "one" });
  assert.equal(events.filter((x) => x === "ack:one").length, 1);
});
test("入站持久化，重启后重试，按原Trigger id交给原型去重", async () => {
  const values = new Map(),
    delivered = [];
  let broken = true;
  const runtime = {
    ready: Promise.resolve(),
    store: {
      set: (k, v) => values.set(k, v),
      get: (k) => values.get(k),
      keys: (f) => [...values.keys()].filter((k) => k.startsWith(f.prefix)),
      delete: (k) => values.delete(k),
    },
    receive: (t) => {
      if (broken) throw Error("offline");
      delivered.push(t.id);
    },
  };
  await assert.rejects(new Inbox(runtime, () => {}).receive({ id: "one" }));
  assert.equal(values.size, 1);
  broken = false;
  await new Inbox(runtime, () => {}).drain();
  assert.deepEqual(delivered, ["one"]);
  assert.equal(values.size, 0);
});
test("并行工具调用使用各自Bot环境并恢复共享spawn", async () => {
  const results = [],
    service = {
      spawn: (s) => {
        results.push(s.env);
        return s;
      },
      spawnTerminal: (s) => s,
    };
  const original = service.spawn,
    restore = routeSubprocess(service);
  const hooks = [];
  for (const id of ["a", "b"])
    bindExecution(
      {
        ctx: {
          on: (_event, fn) => {
            hooks.push(fn);
            return () => {};
          },
        },
      },
      "/tmp/" + id,
      "/usr/bin",
    );
  await Promise.all(
    hooks.map((hook, i) =>
      hook({}, async () => {
        await new Promise((r) => setTimeout(r, (1 - i) * 5));
        service.spawn({ argv: ["git"], env: { CUSTOM: String(i) } });
      }),
    ),
  );
  assert.equal(
    results.find((x) => x.CUSTOM === "0").GIT_CONFIG_GLOBAL,
    "/tmp/a/worker-gitconfig",
  );
  assert.equal(
    results.find((x) => x.CUSTOM === "1").GIT_CONFIG_GLOBAL,
    "/tmp/b/worker-gitconfig",
  );
  restore();
  assert.equal(service.spawn, original);
});
