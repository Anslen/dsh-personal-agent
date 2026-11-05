// SPDX-License-Identifier: GPL-3.0-or-later
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { promptText, renderPrompt } from "../prompts/index.mjs";

export const firstReplyKey = (id: string) => "personal:first-reply:" + id;

/** 通过完整提示装配入口持续提供主控分派知识，执行器不重复接收主控职责。 */
export function responseInstructions(runtime: any, agentId: string): string {
  return agentId === runtime.masterId
    ? [
        firstReplyGuard(runtime, "request", {}),
        promptText("agent/responsiveness/taskDispatch"),
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";
}

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
