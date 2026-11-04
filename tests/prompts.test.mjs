import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promptRoot, promptText, renderPrompt } from "../prompts/index.mjs";

test("统一提示清单与源码引用一致，模板参数完整且只替换一次", () => {
  const manifest = JSON.parse(
    readFileSync(join(promptRoot, "manifest.json"), "utf8"),
  );
  const seen = new Set();
  for (const item of manifest) {
    assert.equal(seen.has(item.key), false, item.key);
    seen.add(item.key);
    const text = promptText(item.key);
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0, item.key);
    const source = join(promptRoot, "..", item.source);
    assert.ok(existsSync(source), item.source);
    assert.ok(readFileSync(source, "utf8").includes(item.key), item.key);
    const names = [
      ...new Set([...text.matchAll(/\{\{(p\d+)\}\}/g)].map((m) => m[1])),
    ].sort();
    assert.deepEqual(
      names,
      item.parameters.map((p) => p.name).sort(),
      item.key,
    );
    const parameters = Object.fromEntries(
      names.map((name) => [name, name + " {{p999}} $&"]),
    );
    const rendered = renderPrompt(item.key, parameters);
    const expected = text.replace(
      /\{\{(p\d+)\}\}/g,
      (_, name) => parameters[name],
    );
    assert.equal(rendered, expected, item.key);
    if (names.length)
      assert.throws(() => renderPrompt(item.key, {}), /提示参数缺失/);
  }
  const count = ["agent", "qq", "stickers", "superagent"].reduce(
    (n, group) =>
      n +
      Object.keys(
        JSON.parse(readFileSync(join(promptRoot, "catalog", group + ".json"))),
      ).length,
    0,
  );
  const files = JSON.parse(readFileSync(join(promptRoot, "files.json")));
  assert.equal(seen.size, count + Object.keys(files).length);
  assert.throws(() => promptText("unknown/test"), /未知提示分组/);
  assert.throws(() => promptText("agent/missing"), /缺少提示/);
});

test("原有模板、技能和配置示例路径仍能读取统一目录中的同一内容", () => {
  for (const [old, current] of [
    ["modules/superagent/prompts/shared.md", "superagent/shared.md"],
    [
      "modules/superagent/skills/dsh-superagent-github/SKILL.md",
      "skills/superagent/dsh-superagent-github/SKILL.md",
    ],
    ["modules/qq/skills/local-tts/SKILL.md", "skills/qq/local-tts/SKILL.md"],
    ["examples/chatbot-prompts.json", "profiles/chatbot.json"],
  ])
    assert.equal(
      readFileSync(join(promptRoot, "..", old), "utf8"),
      readFileSync(join(promptRoot, current), "utf8"),
    );
});
