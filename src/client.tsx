// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from "react";
import { App } from "../modules/superagent/src/client/app.tsx";
import { en, zh } from "../modules/superagent/src/client/locales.ts";
import { openKnownSession } from "../modules/superagent/src/navigation.ts";
export const inject = ["slots", "locale", "sessions", "uiWorkspace"];
function Panel({ ctx, t }: any) {
  const [bots, setBots] = useState<string[]>([]),
    [selected, select] = useState(""),
    [error, fail] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    fetch("/personal-agent/bots", {
      headers: { "x-orchestrator-request": "1" },
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw Error("读取Bot列表失败：" + response.status);
        return response.json();
      })
      .then((value) => {
        setBots(value.bots);
        select(value.bots[0] || "");
      })
      .catch((e) => {
        if (!abort.signal.aborted) fail(e.message);
      });
    return () => abort.abort();
  }, []);
  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <label style={{ display: "block", padding: 12 }}>
        Bot：
        <select
          aria-label="选择Bot"
          value={selected}
          onChange={(event) => select(event.target.value)}
        >
          {bots.map((id) => (
            <option key={id}>{id}</option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {selected && (
        <App
          key={selected}
          apiBase={"/personal-agent/" + selected}
          t={t}
          deploymentForm={undefined}
          openSession={async (id) => {
            await openKnownSession(ctx.sessions, id as any, (target) =>
              ctx.uiWorkspace.openSession(target),
            );
          }}
        />
      )}
    </div>
  );
}
export function apply(ctx: any) {
  ctx.effect(() => ctx.locale.register("personalAgent", { zh, en }));
  ctx.slots.inject("main", () =>
    ctx.slots.register(
      {
        name: "main",
        key: "personal-agent",
        locale: "personalAgent",
        inject: () => ({}),
      },
      (props: any) => <Panel ctx={ctx} t={props.t} />,
    ),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: "personal-agent",
        order: 10,
        label: () => "个人助手",
      },
      ({ size }: any) => <span style={{ fontSize: size }}>◈</span>,
    ),
  );
}
