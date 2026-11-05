import test from "node:test";
import assert from "node:assert/strict";
import { qqGroupPolicy, qqSource, qqTrigger } from "../src/qq-source.ts";
import {
  SettingsSchema,
  settingsPolicy,
} from "../modules/superagent/src/policy.ts";

test("白名单群的其他成员提及可准入，普通消息与未授权群及私聊保持关闭", () => {
  const bot = {
    id: "fish",
    allowedUsers: ["owner"],
    allowedGroups: ["new-group"],
  };
  const old = {
    allowed: [{ id: "owner" }],
    admission: { existing: { unlistedAddressed: "explicit" } },
  };
  const settings = SettingsSchema.parse({
    sources: { qq: { enabled: true, config: {} } },
    policy: { sources: { qq: qqGroupPolicy(old, bot.allowedGroups) } },
  });
  const source = qqSource(bot);
  const policy = settingsPolicy(settings, {
    scope: (input) => source.scope(input),
  });
  const message = {
    kind: "group",
    groupOpenid: "new-group",
    senderId: "other-member",
    messageId: "message",
    timestamp: new Date().toISOString(),
    content: "你好",
  };
  const mentioned = qqTrigger("fish", message, {
    mention: { wasMentioned: true },
  });
  const thread = { subscriptions: [] };
  assert.equal(
    settingsPolicy(SettingsSchema.parse({ policy: { sources: { qq: old } } }), {
      scope: (input) => source.scope(input),
    }).gate(mentioned, thread, []).admissible,
    false,
  );
  assert.equal(source.scope(mentioned).listened, true);
  const verdict = policy.gate(mentioned, thread, []);
  assert.equal(verdict.admissible, true);
  assert.equal(verdict.strength, "explicit");
  assert.equal(
    policy.gate(qqTrigger("fish", message), thread, []).admissible,
    false,
  );
  const outside = qqTrigger(
    "fish",
    { ...message, groupOpenid: "unknown-group" },
    { mention: { wasMentioned: true } },
  );
  assert.equal(source.scope(outside).listened, false);
  assert.equal(policy.gate(outside, thread, []).admissible, false);
  const direct = qqTrigger("fish", { ...message, kind: "c2c" });
  assert.equal(source.scope(direct).listened, false);
  assert.equal(policy.gate(direct, thread, []).admissible, false);
  assert.deepEqual(
    settings.policy.sources.qq.admission.existing,
    old.admission.existing,
  );
  assert.deepEqual(
    qqGroupPolicy(settings.policy.sources.qq, bot.allowedGroups),
    settings.policy.sources.qq,
  );
  assert.equal(old.admission["new-group"], undefined);
});
