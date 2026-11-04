// SPDX-License-Identifier: GPL-3.0-or-later
import { mentionGate } from "@tencent-connect/qqbot-nodejs";

// 先保存获准接收的消息；普通群消息在扩展、聚合和模型处理前结束。
export function archiveAndMentionOnly(observe) {
  const gate = mentionGate({
    requireMentionInGroup: true,
    resolveConfig: () => ({ requireMentionInGroup: true }),
  });
  return async (ctx, next) => {
    await observe(ctx.message, ctx.state);
    return gate(ctx, next);
  };
}
