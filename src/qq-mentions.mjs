// SPDX-License-Identifier: GPL-3.0-or-later
// 回复对象取自原始消息的发送者，不从正文中的@或引用作者猜测。
export function groupReplyText(text, senderId) {
  if (!senderId) return text;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(senderId))
    throw Error("群回复发送者标识无效");
  const escaped = senderId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    new RegExp(
      `<@!?${escaped}>|<qqbot-at-user\\s+id=["']${escaped}["']\\s*\\/>`,
    ).test(text)
  )
    return text;
  return `<@${senderId}> ${text}`.trimEnd();
}
