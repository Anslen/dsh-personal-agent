import { resolve } from "node:path";

// 发送前核对当前会话的真实工具记录，布尔参数不能代替看图记录。
export function assertViewed(events, preview, now = Date.now()) {
  if (!Array.isArray(events)) throw new Error("无法核对当前会话的看图记录");
  const calls = events
    .filter(
      (e) =>
        e.type === "tool/call" &&
        e.time >= now - 300000 &&
        e.data?.name === "read_image",
    )
    .filter((e) => {
      try {
        return (
          resolve(JSON.parse(e.data.arguments).file_path) === resolve(preview)
        );
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
          e.data.message.isError !== true,
      ),
    )
  )
    throw new Error("请先用read_image实际查看当前候选的preview，再发送表情");
}
