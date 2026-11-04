// SPDX-License-Identifier: GPL-3.0-or-later
// 提示只做文本加载和占位符替换，不执行提示文件中的代码。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function locateRoot() {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    const manifest = join(directory, "package.json");
    if (
      existsSync(manifest) &&
      JSON.parse(readFileSync(manifest, "utf8")).name === "dsh-personal-agent"
    )
      return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw Error("找不到提示目录所属的插件根目录");
}
export const promptRoot = join(locateRoot(), "prompts");
const catalogs = new Map();
const files = JSON.parse(readFileSync(join(promptRoot, "files.json"), "utf8"));
export function promptText(key) {
  if (Object.hasOwn(files, key))
    return readFileSync(join(promptRoot, files[key]), "utf8");
  const group = key.split("/")[0];
  if (!["agent", "stickers", "qq", "superagent"].includes(group))
    throw Error("未知提示分组：" + group);
  if (!catalogs.has(group))
    catalogs.set(
      group,
      JSON.parse(
        readFileSync(join(promptRoot, "catalog", group + ".json"), "utf8"),
      ),
    );
  const catalog = catalogs.get(group);
  if (!Object.hasOwn(catalog, key) || typeof catalog[key] !== "string")
    throw Error("缺少提示：" + key);
  return catalog[key];
}
export function renderPrompt(key, parameters = {}) {
  // 单次替换保证用户数据中的占位符不会被递归解释。
  return promptText(key).replace(/\{\{(p\d+)\}\}/g, (_, name) => {
    if (!Object.hasOwn(parameters, name))
      throw Error("提示参数缺失：" + key + ":" + name);
    return String(parameters[name]);
  });
}
