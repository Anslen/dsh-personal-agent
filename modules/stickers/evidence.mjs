import { promptText, renderPrompt } from "../../prompts/index.mjs";
import { resolve } from "node:path";

// 发送前核对当前会话的真实工具记录，布尔参数不能代替看图记录。
export function assertViewed(events, preview, now = Date.now(), id) {
  if (!Array.isArray(events)) throw new Error("无法核对当前会话的看图记录");
  const calls = events
    .filter(
      (e) =>
        e.type === "tool/call" &&
        e.time >= now - 300000 &&
        ["read_image", "sticker_view"].includes(e.data?.name),
    )
    .filter((e) => {
      try {
        const args = JSON.parse(e.data.arguments);
        return e.data.name === "sticker_view"
          ? Boolean(id && args.id === id)
          : resolve(args.file_path) === resolve(preview);
      } catch {
        return false;
      }
    });
  if (
    !calls.some((call) =>
      events.some(
        (e) =>
          e.type === "tool/result" &&
          e.data?.message?.toolCallId === call.data.callId &&
          e.data.message.isError !== true &&
          (call.data.name !== "sticker_view" ||
            e.data.message.content?.some(
              (part) => part.type === "image" && part.attachment,
            )),
      ),
    )
  )
    throw new Error(promptText("stickers/evidence/assertViewed"));
}
