import { promptText, renderPrompt } from "../../../../../prompts/index.mjs";
/**
 * memory.mjs — 让她自己决定"记什么"（长期记忆的写入端）
 *
 * 为什么需要它：入站扩展只能沉淀**原话**（episode），真正的记忆应该是**提炼后的事实**。
 * 让她在对话里主动记一条，比机器猜准得多。
 *
 * scope 怎么解决：工具拿不到"当前是哪个群"，所以 add 只写**公共收件箱**，
 * 入站扩展在下一条消息到来时把它并进当前群（延迟一条消息，但绝不会写错群）。
 *
 * 用 /tools-reload 热加载，不用重启。
 */

// 存储后端在门面里选：优先 SQLite（memory-db），不可用自动回退 JSONL（memory-core）。
import { loadConfig, pushInbox, listAll, forgetAnywhere, remember } from '../lib/memory.mjs';

const DATA_ROOT_FALLBACK = 'F:/qqbot/dshqqbot';

function dataRoot() {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  try {
    const cfg = loadConfig(DATA_ROOT_FALLBACK);
    return cfg.dataRoot || DATA_ROOT_FALLBACK;
  } catch {
    return DATA_ROOT_FALLBACK;
  }
}

const KINDS = new Set(['fact', 'event', 'preference', 'relation']);

export default {
    name: 'memory',
    // description 刻意写短 —— 工具 schema 是每请求的固定开销
    description:
        promptText('qq/dshqqbot/.qqbot-extensions/tools/memory/memory.description') +
        promptText('qq/dshqqbot/.qqbot-extensions/tools/memory/memory.description.2'),
    inputSchema: {
        action: {
            type: 'string',
            required: true,
            description: promptText('qq/dshqqbot/.qqbot-extensions/tools/memory/memory.description.3')
        },
        text: {
            type: 'string',
            description: promptText('qq/dshqqbot/.qqbot-extensions/tools/memory/memory.description.4')
        },
        kind: {
            type: 'string',
            description: promptText('qq/dshqqbot/.qqbot-extensions/tools/memory/memory.description.5')
        },
        subj: {
            type: 'string',
            description: promptText('qq/dshqqbot/.qqbot-extensions/tools/memory/memory.description.6')
        },
        id: {
            type: 'string',
            description: promptText('qq/dshqqbot/.qqbot-extensions/tools/memory/memory.description.7')
        },
        limit: {
            type: 'number',
            description: promptText('qq/dshqqbot/.qqbot-extensions/tools/memory/memory.description.8')
        }
    },

    run: async (args, env) => {
        const log = env?.logger || console;
        const action = String(args?.action || '').trim();
        const root = dataRoot();

        try {
            if (action === 'add') {
                const text = String(args?.text || '').trim();
                if (!text) return { ok: false, msg: 'text 不能为空' };
                if (text.length > 120) return { ok: false, msg: `太长（${text.length} 字）—— 压到 80 字以内再记` };
                const kind = KINDS.has(args?.kind) ? args.kind : 'fact';
                // 直接进当前 scope 也行，但工具不知道 scope ⇒ 进收件箱，下条消息并入当前群
                const r = pushInbox(root, { text, kind, subj: args?.subj });
                if (!r.ok) return { ok: false, msg: `没记住：${r.reason}` };
                return { ok: true, msg: `记下了（${kind}）：${text}` };
            }

            if (action === 'list') {
                const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20));
                const items = listAll(root, { limit });
                if (items.length === 0) return { ok: true, msg: '记忆库还是空的。' };
                const lines = items.map((x, i) => `${i + 1}. [${x.id}] (${x.kind || '?'}) ${x.text}`);
                return { ok: true, msg: `最近 ${items.length} 条记忆：\n` + lines.join('\n') };
            }

            if (action === 'forget') {
                const id = String(args?.id || '').trim();
                if (!id) return { ok: false, msg: 'id 不能为空（先 list 看 id）' };
                const ok = forgetAnywhere(root, id);
                return { ok, msg: ok ? `已删 ${id}` : `没找到 ${id}` };
            }

            return { ok: false, msg: `不认识的 action: ${action}（add | list | forget）` };
        } catch (e) {
            log.warn?.(`[memory-tool] 异常: ${e instanceof Error ? e.message : String(e)}`);
            return { ok: false, msg: '记忆操作出错了（已忽略，不影响聊天）' };
        }
    }
};

/** 便于外部脚本复用：把一个 scope 的记忆直接灌进去（不做收件箱） */
export async function rememberInto(root, scope, text, kind = 'fact', subj = '') {
  const cfg = loadConfig(root);
  return remember(root, scope, { text, kind, subj }, cfg);
}
