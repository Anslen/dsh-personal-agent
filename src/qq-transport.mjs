// SPDX-License-Identifier: GPL-3.0-or-later
// 渠道层只负责转交和发送；外部驱动缺失或失败时不得进入原插件模型会话。
const transports = new Map();
const drivers = new Map();
export function registerTransport(id, sender) {
  if (transports.has(id)) throw new Error("Bot渠道重复注册");
  transports.set(id, sender);
  return () => {
    if (transports.get(id) === sender) transports.delete(id);
  };
}
export function registerDriver(id, driver) {
  if (drivers.has(id)) throw new Error("Bot编排驱动重复注册");
  drivers.set(id, driver);
  return () => {
    if (drivers.get(id) === driver) drivers.delete(id);
  };
}
export async function observe(id, message, state) {
  const driver = drivers.get(id);
  if (!driver) throw Error("QQ历史记录器尚未就绪");
  await driver.observe?.(message, state);
}
export async function receive(id, message, state) {
  const driver = drivers.get(id);
  if (!driver) throw new Error("外部编排驱动尚未就绪，消息不能进入默认回复链");
  await driver.receive(message, state);
}
export async function send(id, kind, target, content) {
  const sender = transports.get(id);
  if (!sender) throw new Error("QQ渠道尚未就绪");
  if (kind === "text") return sender.sendText(target, content);
  if (kind === "markdown") return sender.sendMarkdown(target, content);
  if (["image", "voice", "video", "file"].includes(kind))
    return sender.sendMedia(target, kind, content);
  throw new Error("不支持的消息类型");
}
