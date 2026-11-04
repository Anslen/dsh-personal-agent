// SPDX-License-Identifier: GPL-3.0-or-later
const keepMs = 7 * 86400000,
  maxRows = 2000;
const key = (scope: string, peer: string) =>
  "personal:history:" + scope + ":" + peer;
export function recordHistory(
  runtime: any,
  bot: any,
  message: any,
  state?: any,
) {
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
  const saved = (runtime.store.get(key(scope, peer)) || []).filter(
    (r: any) => Date.parse(r.at) > Date.now() - keepMs,
  );
  const previous = saved.find((r: any) => r.id === id);
  const ref = message.refMsgIdx || state?.quote?.refKey;
  const parent =
    ref && saved.find((r: any) => r.id === ref || r.ref_index === ref);
  const quote = state?.quote;
  const entry =
    quote?.entry?.peerId === peer && quote.entry.scope === message.kind
      ? quote.entry
      : undefined;
  const quoteText =
    quote?.source === "msg_elements"
      ? (quote.rawContent ?? quote.text ?? "")
      : (entry?.content ?? "");
  // 引用只在同Bot、同会话的台账内解析，重启后仍可按平台消息索引找到原文。
  const reply = ref
    ? {
        ref,
        available: !!parent || !!entry || quote?.source === "msg_elements",
        ...(parent
          ? {
              id: parent.id,
              from: parent.from,
              name: parent.name,
              at: parent.at,
              text: parent.text,
              attachments: parent.attachments,
            }
          : {
              id: entry?.messageId,
              from: entry?.senderId,
              name: entry?.senderName,
              at: entry?.timestamp,
              text: quoteText,
              attachments:
                quote?.source === "msg_elements"
                  ? quote.attachments || []
                  : entry?.attachments || [],
            }),
      }
    : previous?.reply;
  const row = {
    id,
    from: message.senderId,
    name: message.senderName || "",
    at: new Date(time).toISOString(),
    text: String(message.content || "").slice(0, 12000),
    attachments: message.attachments || [],
    ...(message.msgIdx || previous?.ref_index
      ? { ref_index: message.msgIdx || previous.ref_index }
      : {}),
    ...(reply ? { reply } : {}),
  };
  const rows = saved.filter(
    (r: any) => r.id !== id && Date.parse(r.at) > Date.now() - keepMs,
  );
  rows.push(row);
  rows.sort((a: any, b: any) => Date.parse(a.at) - Date.parse(b.at));
  runtime.store.set(key(scope, peer), rows.slice(-maxRows));
  return row;
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
      ...(t.meta.reply ? { reply: t.meta.reply } : {}),
    }));
  const combined = new Map(
    [...prior, ...(runtime.store.get(key(scope, peer)) || [])].map((r: any) => [
      r.id,
      r,
    ]),
  );
  let cursor: any;
  const parseTime = (value: string | undefined) => {
    if (!value) return undefined;
    if (
      !/(Z|[+-]\d{2}:\d{2})$/i.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      throw Error("时间须为包含时区的ISO时间，如2026-11-04T15:00:00+08:00");
    return Date.parse(value);
  };
  const start = parseTime(options.start_time),
    end = parseTime(options.end_time);
  if (start !== undefined && end !== undefined && start > end)
    throw Error("开始时间不能晚于结束时间");
  if (options.before) {
    try {
      cursor = JSON.parse(Buffer.from(options.before, "base64url").toString());
    } catch {
      cursor = { at: options.before };
    }
    if (!Number.isFinite(Date.parse(cursor.at)))
      throw Error("历史游标时间无效");
  }
  const archived: any[] = [...combined.values()]
    .filter((r: any) => Date.parse(r.at) > Date.now() - keepMs)
    .sort(
      (a: any, b: any) =>
        Date.parse(b.at) - Date.parse(a.at) ||
        String(b.id).localeCompare(String(a.id)),
    )
    .slice(0, maxRows);
  const rows = archived.filter(
    (r: any) =>
      (start === undefined || Date.parse(r.at) >= start) &&
      (end === undefined || Date.parse(r.at) <= end) &&
      (!options.sender ||
        options.sender === "*" ||
        r.from === options.sender ||
        r.name === options.sender) &&
      (!cursor ||
        Date.parse(r.at) < Date.parse(cursor.at) ||
        (r.at === cursor.at &&
          cursor.id &&
          String(r.id).localeCompare(String(cursor.id)) < 0)) &&
      (!options.keyword ||
        r.text.toLowerCase().includes(options.keyword.toLowerCase())),
  );
  const messages = rows.slice(0, options.limit || 50);
  const result = {
    messages,
    snapshot: {
      queried_at: new Date().toISOString(),
      total_messages: archived.length,
      latest_message_at: archived[0]?.at || null,
      matched_messages: rows.length,
      freshness:
        "仅供紧接本次查询后的处理使用；后续模型调用均假定可能已有新消息，需要历史信息时重新查询。",
    },
    filters: {
      sender: options.sender || "*",
      ...(options.start_time ? { start_time: options.start_time } : {}),
      ...(options.end_time ? { end_time: options.end_time } : {}),
    },
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
  // 可选引用字段同样省略缺省值，交给宿主前确保返回值符合JSON工具契约。
  return JSON.parse(JSON.stringify(result));
}
