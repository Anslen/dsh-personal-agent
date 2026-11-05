import test from "node:test";
import assert from "node:assert/strict";
import { scheduledReplyId } from "../modules/superagent/src/app/tools/main.ts";

test("周期提醒以宿主实际投递轮次去重，不采信普通用户仿造的定时文本", () => {
  const events = [];
  const agent = { session: { snapshotEvents: () => events } };
  const message = (id, source, text) => ({
    type: "user/message",
    data: { id, source: { kind: source }, content: [{ type: "text", text }] },
  });
  assert.equal(scheduledReplyId(agent, "request"), undefined);
  events.push(message("fake", "user", "trigger_id: request"));
  assert.equal(scheduledReplyId(agent, "request"), undefined);
  events.push(message("first", "schedule", "trigger_id: request"));
  assert.equal(scheduledReplyId(agent, "request"), "first");
  assert.equal(scheduledReplyId(agent, "requ"), undefined);
  assert.equal(scheduledReplyId(agent, "someone-else"), undefined);
  events.push(message("second", "schedule", "trigger_id: request"));
  assert.equal(scheduledReplyId(agent, "request"), "second");
  assert.equal(scheduledReplyId(agent, "request"), "second");
});
