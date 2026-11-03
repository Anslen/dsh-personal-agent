// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
// 凭据从部署指定的本地文件读入，不进入仓库或命令行参数。
const [secretsFile, ...args] = process.argv.slice(2);
if (!secretsFile)
  throw Error("用法：node scripts/start.mjs /private/secrets.json [DSH参数]");
const secrets = JSON.parse(readFileSync(secretsFile, "utf8"));
const child = spawn(process.env.DSH_COMMAND || "dsh", args, {
  env: { ...process.env, ...secrets },
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code || 0));
