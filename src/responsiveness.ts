// SPDX-License-Identifier: GPL-3.0-or-later
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { renderPrompt } from "../prompts/index.mjs";

export const firstReplyKey = (id: string) => "personal:first-reply:" + id;

/** 只约束首次回应顺序，主控回应后仍可自主使用工具或分派后台任务。 */
export function firstReplyGuard(runtime: any, name: string, args: any) {
  const pending = runtime.store.threads
    .active()
    .flatMap((thread: any) =>
      thread.evaluating?.delivered ? thread.evaluating.triggerIds : [],
    )
    .filter((id: string) => {
      const trigger = runtime.store.triggers.get(id);
      return (
        trigger?.human &&
        trigger.dispatch === "orchestrator" &&
        !runtime.store.get(firstReplyKey(id))
      );
    });
  if (!pending.length || name === "orchestrator_reply") return;
  if (
    name === "orchestrator_route" &&
    args?.decisions?.every(
      (item: any) =>
        !pending.includes(item.trigger_id) || item.kind === "accept",
    )
  )
    return;
  return renderPrompt("agent/responsiveness/firstReply", {
    p0: pending.join(", "),
  });
}

export function bindResponsiveness(
  agent: any,
  runtime: () => any,
  effort?: string,
) {
  const release = [
    agent.ctx.tools.guard((execution: any) => {
      const host = runtime();
      if (agent.id === host.masterId)
        return firstReplyGuard(host, execution.name, execution.arguments);
    }),
    // 每次组装请求时明确当前待回应对象，减少先试工具再被拦截的一轮往返。
    agent.ctx.systemPrompt.section({
      name: "personal-first-reply",
      order: 10000,
      interpolate: false,
      text: () => {
        const host = runtime();
        return agent.id === host.masterId
          ? firstReplyGuard(host, "request", {}) || ""
          : "";
      },
    }),
  ];
  if (effort)
    release.push(
      agent.ctx.on(
        "agent/request",
        async (_payload: any, next: any) => {
          const request = await next();
          return { ...request, reasoningEffort: ReasoningEffortId(effort) };
        },
        { prepend: true },
      ),
    );
  return () => release.forEach((dispose) => dispose());
}
