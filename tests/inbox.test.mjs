import test from "node:test";
import assert from "node:assert/strict";
import { Inbox } from "../src/inbox.ts";
import { bindExecution, routeSubprocess } from "../src/execution-scope.ts";
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
