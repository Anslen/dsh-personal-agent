import { promptText, renderPrompt } from "../../../../../prompts/index.mjs";
/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool(
      'Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true,
      (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)
    ),
    tool({
      name: 'orchestrator_ack',
      description: promptText('superagent/app/tools/executor/orchestrator_ack.description'),
      schema: z
        .object({
          trigger_id: z.string(),
          text: AcknowledgementSchema.describe(renderPrompt('superagent/app/tools/executor/text', { p0: IM_WORDS }))
        })
        .strict(),
      execute: async (args) => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      }
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: promptText('superagent/app/tools/executor/orchestrator_thread_unrelated.description'),
      schema: z
        .object({
          thread: z.string().min(1).describe(promptText('superagent/app/tools/executor/thread')),
          reason: z.string().trim().min(1).max(300).describe(promptText('superagent/app/tools/executor/reason'))
        })
        .strict(),
      execute: async (args) => {
        host.engine.markUnrelated(ticketId, args.thread, args.reason)
        return { removed: true, thread: args.thread }
      }
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: promptText('superagent/app/tools/executor/orchestrator_thread_follow.description'),
      schema: z
        .object({
          thread: z.string().describe(promptText('superagent/app/tools/executor/thread.2')),
          reason: z.string().trim().min(1).max(300).describe(promptText('superagent/app/tools/executor/reason.2'))
        })
        .strict(),
      execute: async (args) =>
        host.store.atomic(() => {
          const at = args.thread.indexOf(':')
          if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
          const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
          if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
          return { followed, thread: args.thread }
        })
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: promptText('superagent/app/tools/executor/orchestrator_trigger_handback.description'),
      schema: z
        .object({
          trigger_id: z.string().min(1),
          reason: z.string().trim().min(1).max(300).describe(promptText('superagent/app/tools/executor/reason.3'))
        })
        .strict(),
      execute: async (args) => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) })
    }),
    tool({
      name: 'orchestrator_report',
      description: promptText('superagent/app/tools/executor/orchestrator_report.description'),
      schema: z
        .object({
          state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
          summary: z.string().min(1),
          human_action: z.string().trim().min(1).max(1000).nullish().describe(promptText('superagent/app/tools/executor/human_action')),
          question_for_trigger_id: z.string().optional().describe(promptText('superagent/app/tools/executor/question_for_trigger_id')),
          pr_number: z
            .number()
            .int()
            .positive()
            .nullish()
            .describe(renderPrompt('superagent/app/tools/executor/pr_number', { p0: host.github.deployment.github.login })),
          reply_to_trigger_id: z.string().optional().describe(promptText('superagent/app/tools/executor/reply_to_trigger_id'))
        })
        .strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const report = {
            state: args.state,
            summary: args.summary,
            ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {})
          }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      }
    })
  ]
}
