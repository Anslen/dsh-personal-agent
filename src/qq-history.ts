// SPDX-License-Identifier: GPL-3.0-or-later
const keepMs = 7 * 86400000,
  maxRows = 2000;
const key = (scope: string, peer: string) =>
  "personal:history:" + scope + ":" + peer;
export function recordHistory(runtime: any, bot: any, message: any) {
  const scope = message.kind === "group" ? "group" : "c2c",
    peer = message.groupOpenid || message.peerId || message.senderId;
  if (
    !peer ||
    !(scope === "group" ? bot.allowedGroups : bot.allowedUsers).includes(peer)
  )
    return;
  const id = message.messageId;
  if (!id) return;
  const time = new Date(message.timestamp || Date.now()).getTime();
  if (!Number.isFinite(time)) return;
  const row = {
    id,
    from: message.senderId,
    name: message.senderName || "",
    at: new Date(time).toISOString(),
    text: String(message.content || "").slice(0, 12000),
    attachments: message.attachments || [],
  };
  const rows = (runtime.store.get(key(scope, peer)) || []).filter(
    (r: any) => r.id !== id && Date.parse(r.at) > Date.now() - keepMs,
  );
  rows.push(row);
  rows.sort((a: any, b: any) => Date.parse(a.at) - Date.parse(b.at));
  runtime.store.set(key(scope, peer), rows.slice(-maxRows));
}
export function readHistory(
  runtime: any,
  bot: any,
  scope: string,
  peer: string,
  options: any = {},
) {
  if (
    !(scope === "group" ? bot.allowedGroups : bot.allowedUsers).includes(peer)
  )
    throw Error("该会话不在当前Bot允许范围");
  // 兼容接入前已持久化的主控消息；新台账另含未触发主控的已收到消息。
  const prior = runtime.store.read
    .threadPage("qq:" + bot.id + ":" + scope + ":" + peer, 0, 200)
    .map((t: any) => ({
      id: t.meta.messageId,
      from: t.actor.id,
      at: t.at,
      text: t.text,
      attachments: t.meta.attachments || [],
    }));
  const combined = new Map(
    [...prior, ...(runtime.store.get(key(scope, peer)) || [])].map((r: any) => [
      r.id,
      r,
    ]),
  );
  let cursor: any;
  if (options.before) {
    try {
      cursor = JSON.parse(Buffer.from(options.before, "base64url").toString());
    } catch {
      cursor = { at: options.before };
    }
    if (!Number.isFinite(Date.parse(cursor.at)))
      throw Error("历史游标时间无效");
  }
  const rows: any[] = [...combined.values()]
    .filter((r: any) => Date.parse(r.at) > Date.now() - keepMs)
    .sort(
      (a: any, b: any) =>
        Date.parse(b.at) - Date.parse(a.at) ||
        String(b.id).localeCompare(String(a.id)),
    )
    .slice(0, maxRows)
    .filter(
      (r: any) =>
        (!cursor ||
          Date.parse(r.at) < Date.parse(cursor.at) ||
          (r.at === cursor.at &&
            cursor.id &&
            String(r.id).localeCompare(String(cursor.id)) < 0)) &&
        (!options.keyword ||
          r.text.toLowerCase().includes(options.keyword.toLowerCase())),
    );
  const messages = rows.slice(0, options.limit || 50);
  return {
    messages,
    ...(rows.length > messages.length
      ? {
          next_before: Buffer.from(
            JSON.stringify({ at: messages.at(-1).at, id: messages.at(-1).id }),
          ).toString("base64url"),
        }
      : {}),
    coverage:
      "仅包含当前Bot实际收到并保存的消息，最多最近7天、每个会话2000条；不代表QQ群完整历史",
  };
}
