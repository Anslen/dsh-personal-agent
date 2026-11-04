import { promptText, renderPrompt } from "../../../../prompts/index.mjs";
import { getScopePeer } from '../shared/index.js';
import { answerPendingQuestionByText } from '../features/qq-user-questions.js';
const USAGE = [
    '用法: `/答 <选项字母|序号|你的回答>`',
    '例: `/答 A`(选第一个)、`/答 1 3`(多选)、`/答 #2 B`(第2问)、`/答 我觉得再等等`(自由回答)',
].join('\n');
/** /答（中文主命令）：把斜杠后面的文字当成对当前待答提问的回答 */
export function answerCommand({ config }) {
    return {
        name: '答',
        description: promptText('qq/commands/answer/答.description'),
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const raw = String(cmdCtx.command?.raw ?? '').trim();
            if (raw === '') return USAGE;
            const senderId = String(cmdCtx.message?.senderId ?? '');
            const ns = String(config.settingsNs ?? '').trim() || 'im-qqbot';
            const r = answerPendingQuestionByText({ ns, scope, peerId, senderId, text: raw });
            return r.ok ? `✅ ${r.msg}` : `⚠️ ${r.msg}\n\n${USAGE}`;
        }
    };
}
/** /ans（英文简写别名, 复用同一 handler） */
export function answerAliasCommand(deps) {
    const base = answerCommand(deps);
    return { name: 'ans', description: promptText('qq/commands/answer/ans.description'), handler: base.handler };
}
//# sourceMappingURL=answer.js.map