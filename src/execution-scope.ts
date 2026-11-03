// SPDX-License-Identifier: GPL-3.0-or-later
import { AsyncLocalStorage } from "node:async_hooks";
import { delimiter } from "node:path";
import {
  agentVariables,
  workerBin,
} from "../modules/superagent/src/infra/environment.ts";
const scope = new AsyncLocalStorage<Record<string, string>>();
// DSH工具从共享subprocess服务启动命令，在异步调用链中合并对应Bot的环境。
export function routeSubprocess(service: any) {
  const releases: (() => void)[] = [];
  for (const method of ["spawn", "spawnTerminal"]) {
    const original = service[method];
    if (typeof original !== "function") continue;
    service[method] = function (spec: any) {
      const env = scope.getStore();
      return original.call(
        this,
        env ? { ...spec, env: { ...env, ...spec.env } } : spec,
      );
    };
    releases.push(() => {
      service[method] = original;
    });
  }
  return () => releases.reverse().forEach((release) => release());
}
export function bindExecution(agent: any, stateDir: string, basePath: string) {
  const env = Object.fromEntries(
    Object.entries(agentVariables(stateDir)).map(([k, v]) => [k, v ?? ""]),
  );
  env.PATH = [workerBin(stateDir), basePath].join(delimiter);
  return agent.ctx.on("tools/execute", (_execution: any, next: any) =>
    scope.run(env, next),
  );
}
