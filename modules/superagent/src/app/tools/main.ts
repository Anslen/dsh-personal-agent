import { promptText, renderPrompt } from "../../../../../prompts/index.mjs";
/** Main Session tools for routing triggers, assessing candidates, sending replies, and updating settings and prompts. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { UserError, followupOwners, key, reasonText, type Decision, type DecisionKind, type EngineForMainSession, type EngineForPeople }
  from '../../core/index.ts'
import { IM_WORDS, NOTE_WORDS, wordCount } from '../../infra/text.ts'
import { AssessmentSchema, EvalReadSchema, WorktreeNameSchema, type MasterAssessor } from '../assessment.ts'
import { ticketCard } from '../cards.ts'
import { PromptConfigSchema, savePrompts, type Prompts } from '../prompts.ts'
import { readResource, type MainResourceHost, type ResourceHost } from '../resources.ts'
import type { Sessions } from '../sessions.ts'
import type { Settings } from '../settings.ts'
import type { Store } from '../store.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

/** 从宿主的定时投递消息取得稳定轮次，避免相同提醒文本被历史去重吞掉。 */
export function scheduledReplyId(
  agent: { session: { snapshotEvents(): readonly any[] } },
  triggerId?: string,
): string | undefined {
  if (!triggerId) return;
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type !== "user/message" || event.data.source?.kind !== "schedule")
      continue;
    const text =
      event.data.content
        ?.filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("\n") ?? "";
    if (
      [...text.matchAll(/trigger_id:\s*([^\s"\\]+)/g)].some(
        (match) => match[1] === triggerId,
      )
    )
      return event.data.id;
  }
}

const RoutingNoteSchema = z
  .string()
  .trim()
  .refine(
    (text) => wordCount(text) <= NOTE_WORDS,
    `Routing note must not exceed ${NOTE_WORDS} words (Chinese uses word segmentation). Shorten it; do not split it across deliveries.`
  )
  .describe(renderPrompt('superagent/app/tools/main/RoutingNoteSchema', { p0: NOTE_WORDS }))
export interface MainToolsHost {
  readonly context: Context
  readonly engine: Pick<EngineForMainSession, 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note'> & EngineForPeople
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'threads' | 'atomic' | 'replyStatus' | 'settings'>
  readonly prompts: Pick<Prompts, 'preview' | 'save'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery' | 'modelRetry'>
  readonly settings: Pick<Settings, 'view' | 'block' | 'save' | 'pause' | 'sync'>
  readonly assessor: Pick<MasterAssessor, 'context' | 'read' | 'decide'>
  readonly resources: ResourceHost
  /** Schedules a pass to carry out work queued by an Engine command (such as an Eval or ticket resume). */
  requestPass(): void
  sendReplies(): Promise<void>
  /** Runs an Engine command initiated by the main Session without emitting self-notifications. */
  quietly<T>(run: () => T): T
}
/** Schedules an Engine pass to execute the recorded routing decision and formats the tool response. */
function routed(host: MainToolsHost, result: { decision?: DecisionKind; reason: string; ticketId?: string | undefined }) {
  host.requestPass()
  const ticket = result.ticketId ? host.store.tickets.get(result.ticketId) : undefined
  return { ...(result.decision ? { decision: result.decision } : {}), reason: result.reason,
    ...(ticket ? { ticket: ticketCard(ticket) } : {}) }
}
const fromDecision = (decision: Decision) => ({ decision: decision.kind, reason: reasonText(decision.reason), ticketId: decision.ticketId })
/**
 * One routing decision of `orchestrator_route`. The schema holds only its shape: each kind's fields are checked as its item
 * runs (`FIELDS`), so an item that lacks one, or whose value breaks a limit, is refused alone.
 */
const RouteItemSchema = z
  .object({
    kind: z.enum(['accept', 'attach', 'ignore', 'stop']),
    trigger_id: z.string().describe(promptText('superagent/app/tools/main/trigger_id')),
    ticket_id: z.string().nullish().describe(promptText('superagent/app/tools/main/ticket_id')),
    title: z.string().nullish().describe(promptText('superagent/app/tools/main/title')),
    worktree_name: z
      .string()
      .nullish()
      .describe(renderPrompt('superagent/app/tools/main/worktree_name', { p0: WorktreeNameSchema.description ?? '' })),
    acknowledgement: z
      .string()
      .nullish()
      .describe(renderPrompt('superagent/app/tools/main/acknowledgement', { p0: IM_WORDS })),
    note: z
      .string()
      .nullish()
      .describe(renderPrompt('superagent/app/tools/main/note', { p0: RoutingNoteSchema.description ?? '' })),
    reason: z.string().nullish().describe(promptText('superagent/app/tools/main/reason'))
  })
  .strict()
type RouteItem = z.infer<typeof RouteItemSchema>
type Kind = RouteItem['kind']
type Field = Exclude<keyof RouteItem, 'kind' | 'trigger_id'>
/** Each field's check, the kinds whose items read it and those that need it; an item of another kind leaves it unread. */
const FIELDS: Record<Field, { check: z.ZodType; reads: readonly Kind[]; needs: readonly Kind[] }> = {
  ticket_id: { check: z.string(), reads: ['attach', 'stop'], needs: ['attach', 'stop'] },
  title: { check: z.string().max(200), reads: ['accept'], needs: ['accept'] },
  worktree_name: { check: WorktreeNameSchema, reads: ['accept'], needs: ['accept'] },
  acknowledgement: { check: AcknowledgementSchema, reads: ['accept'], needs: ['accept'] },
  note: { check: RoutingNoteSchema, reads: ['accept', 'attach'], needs: [] },
  reason: { check: z.string().max(500), reads: ['ignore', 'stop'], needs: ['ignore'] },
}
/** Why an item cannot run: a field its kind needs is missing, or one it reads breaks its limit. */
function invalid(item: RouteItem): string | undefined {
  for (const [field, { check, reads, needs }] of Object.entries(FIELDS) as [Field, typeof FIELDS[Field]][]) {
    const value = item[field]
    if (!reads.includes(item.kind)) continue
    if (value === undefined || value === null || value.trim() === '') {
      if (needs.includes(item.kind)) return `${item.kind} needs ${field}`
      continue
    }
    const checked = check.safeParse(value)
    if (!checked.success) return `${field}: ${checked.error.issues[0]?.message ?? 'invalid'}`
  }
  return undefined
}
type Routed = { decision?: DecisionKind; reason: string; ticketId?: string | undefined; triggerIds?: readonly string[] }
/**
 * Carry out one routing decision as its Engine command, in a transaction of its own. `decided` holds the Triggers that this
 * call's earlier items decided, with their batches.
 */
function route(host: MainToolsHost, item: RouteItem, decided: ReadonlyMap<string, string>): Routed | { refused: string } {
  const note = item.note ? { note: item.note } : {}
  // A Trigger an earlier item decided went with that item's Decision, also as a member of its batch.
  // A stop of it for another ticket is the Engine's to judge.
  const earlier = decided.get(item.trigger_id)
  if (earlier && item.kind === 'ignore') return { refused: `Decided in this call with ${earlier}, whose Decision took its batch` }
  switch (item.kind) {
    case 'accept': {
      const before = host.store.triggers.disposition(item.trigger_id)?.decisionId
      const decision = host.engine.decide(item.trigger_id, { kind: 'accept', title: item.title!, scope: item.title!, reason: { code: 'explicitRouted' },
        acknowledgement: item.acknowledgement!, name: item.worktree_name!, ...note })
      // A Decision that created no ticket is the item's refusal; one that existed before keeps what it was accepted with.
      if (decision.kind !== 'accept' || !decision.ticketId) return { refused: `Ticket was not created: ${reasonText(decision.reason)}` }
      if (decision.id === before) {
        return { decision: 'accept', reason: `Already accepted as ${decision.ticketId}; title and acknowledgement unchanged`, ticketId: decision.ticketId }
      }
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    case 'attach': {
      const ticket = host.quietly(() => host.engine.attach(item.ticket_id!, item.trigger_id, item.note ?? undefined))
      return { reason: 'Attached: the ticket follows the trigger\'s thread and receives the trigger', ticketId: ticket.id }
    }
    // Through `engine.decide`, so only a person's message the gate admits with explicit strength stops a ticket.
    case 'stop': {
      const decision = host.engine.decide(item.trigger_id, { kind: 'stop', ticketId: item.ticket_id!, reason: item.reason || { code: 'humanStop' } })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    case 'ignore': {
      const decision = host.engine.decide(item.trigger_id, { kind: 'ignore', reason: item.reason! })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
  }
}
/**
 * `orchestrator_route`: routing decisions for several triggers in one call, in order. Each runs as its own Engine command; one
 * that is refused, or fails, is answered so, and the others still run.
 */
function routeTool(host: MainToolsHost): Tool {
  return tool({
    name: 'orchestrator_route',
    description: promptText('superagent/app/tools/main/orchestrator_route.description'),
    schema: z.object({ decisions: z.array(RouteItemSchema).min(1).max(20) }).strict(),
    execute: async ({ decisions }) => {
      const decided = new Map<string, string>()
      const results = decisions.map((item) => {
        const head = { trigger_id: item.trigger_id, kind: item.kind }
        const problem = invalid(item)
        if (problem) return { ...head, refused: problem }
        try {
          const result = route(host, item, decided)
          if ('refused' in result) return { ...head, ...result }
          for (const id of result.triggerIds ?? []) if (!decided.has(id)) decided.set(id, item.trigger_id)
          const ticket = result.ticketId ? host.store.tickets.get(result.ticketId) : undefined
          return {
            ...head,
            ...(result.decision ? { decision: result.decision } : {}),
            reason: result.reason,
            ...(ticket ? { ticket: ticketCard(ticket) } : {})
          }
        } catch (error) {
          if (error instanceof UserError) return { ...head, refused: error.message }
          host.context.logger.warn('dsh-superagent could not route trigger %s: %s', item.trigger_id, String(error))
          return { ...head, refused: `Not recorded: ${error instanceof Error ? error.message : String(error)}; retry this item` }
        }
      })
      host.requestPass()
      return { results }
    }
  })
}
/** Builds the main Session's tools; `agent` scopes prompt preview resources to that Session. */
export function mainTools(host: MainToolsHost, agent: Agent): Tool[] {
  const resources: MainResourceHost = { ...host.resources, sessions: host.sessions, settings: host.settings }
  return [
    readTool(
      'Read one page of a resource the resource parameter lists, such as the ticket list or a ticket. Follow next_offset, and next_resource where a page names one.',
      false,
      (resource, offset, limit, signal) => readResource(resources, resource, offset, limit, undefined, signal)
    ),
    routeTool(host),
    tool({
      name: 'orchestrator_ticket_retry',
      description: promptText('superagent/app/tools/main/orchestrator_ticket_retry.description'),
      schema: z.object({ ticket_id: z.string() }).strict(),
      execute: async (args) => routed(host, { reason: 'Started a new assignment', ticketId: host.engine.retryTicket(args.ticket_id).id })
    }),
    tool({
      name: 'orchestrator_ticket_request_status',
      description: promptText('superagent/app/tools/main/orchestrator_ticket_request_status.description'),
      schema: z.object({ ticket_id: z.string() }).strict(),
      execute: async (args) => {
        const reason = host.engine.requestStatus(args.ticket_id)
          ? 'Asked the worker for a status report'
          : 'The worker is not waiting; nothing was sent'
        return routed(host, { reason, ticketId: args.ticket_id })
      }
    }),
    tool({
      name: 'orchestrator_ticket_note',
      description: promptText('superagent/app/tools/main/orchestrator_ticket_note.description'),
      schema: z
        .object({
          ticket_id: z.string(),
          text: z
            .string()
            .trim()
            .min(1)
            .refine((text) => wordCount(text) <= IM_WORDS, `At most ${IM_WORDS} words`)
        })
        .strict(),
      execute: async (args) => {
        host.engine.note(args.ticket_id, args.text)
        return routed(host, { reason: 'Noted for the worker', ticketId: args.ticket_id })
      }
    }),
    tool({
      name: 'orchestrator_trigger_requeue',
      description: promptText('superagent/app/tools/main/orchestrator_trigger_requeue.description'),
      schema: z.object({ trigger_id: z.string() }).strict(),
      execute: async (args) => {
        // A follow-up that reached a ticket is its worker's to judge, which hands back what is not its own; a person may still requeue it.
        const trigger = host.store.triggers.get(args.trigger_id)
        const owners = trigger ? followupOwners(trigger, host.store) : []
        if (owners.length) throw new UserError('workerDecides', { tickets: owners.join(', ') })
        const queued = host.quietly(() => host.engine.reevaluate(args.trigger_id))
        host.requestPass()
        return { queued }
      }
    }),
    tool({
      name: 'orchestrator_eval',
      description: promptText('superagent/app/tools/main/orchestrator_eval.description'),
      schema: z.object({ trigger_id: z.string() }).strict(),
      execute: async (args, signal) => host.assessor.context(args.trigger_id, signal)
    }),
    tool({
      name: 'orchestrator_eval_read',
      description: promptText('superagent/app/tools/main/orchestrator_eval_read.description'),
      schema: EvalReadSchema,
      execute: async (read, signal) => host.assessor.read(agent, read, signal)
    }),
    tool({
      name: 'orchestrator_eval_decide',
      description: promptText('superagent/app/tools/main/orchestrator_eval_decide.description'),
      schema: z.object({ trigger_id: z.string().min(1), ...AssessmentSchema.shape }).strict(),
      execute: async ({ trigger_id, ...result }, signal) => {
        const decided = await host.assessor.decide(trigger_id, AssessmentSchema.parse(result), signal)
        return routed(host, { decision: decided.state as DecisionKind, reason: decided.reason, ticketId: decided.ticket_id })
      }
    }),
    tool({
      name: 'orchestrator_reply',
      description: renderPrompt('superagent/app/tools/main/orchestrator_reply.description', { p0: IM_WORDS }),
      schema: z
        .object({
          trigger_id: z.string().optional().describe(promptText('superagent/app/tools/main/trigger_id.2')),
          ticket_id: z.string().optional(),
          purpose: z.enum(['answer', 'result', 'attention']),
          human_action: z.string().trim().min(1).optional().describe(promptText('superagent/app/tools/main/human_action')),
          text: z.string().min(1).max(20000)
        })
        .strict(),
      execute: async (args) => {
        const deliveryId = scheduledReplyId(agent, args.trigger_id)
        const reply = host.engine.reply({
          purpose: args.purpose,
          ...(deliveryId ? { deliveryId } : {}),
          text: args.text,
          ...(args.trigger_id ? { triggerId: args.trigger_id } : {}),
          ...(args.ticket_id ? { ticketId: args.ticket_id } : {}),
          ...(args.human_action ? { question: args.human_action } : {})
        })
        await host.sendReplies()
        return { status: host.store.replyStatus(reply.id) ?? reply.status }
      }
    }),
    tool({
      name: 'orchestrator_thread_unsubscribe',
      description: promptText('superagent/app/tools/main/orchestrator_thread_unsubscribe.description'),
      schema: z.object({ thread: z.string().describe(promptText('superagent/app/tools/main/thread')) }).strict(),
      execute: async (args) => {
        return { removed: host.quietly(() => host.engine.unsubscribe(args.thread)), thread: args.thread }
      }
    }),
    tool({
      name: 'orchestrator_settings_save',
      description: promptText('superagent/app/tools/main/orchestrator_settings_save.description'),
      schema: z
        .object({
          block: z.enum(['policy', 'eval', 'executor', 'pause', 'source']).describe(promptText('superagent/app/tools/main/block')),
          source: z.string().min(1).optional().describe(promptText('superagent/app/tools/main/source')),
          value: z.unknown().describe(promptText('superagent/app/tools/main/value')),
          revision: z.number().int().nonnegative().describe(promptText('superagent/app/tools/main/revision'))
        })
        .strict()
        .refine((args) => (args.block === 'source') === (args.source !== undefined), 'source names the Source instance, with block source only'),
      execute: async (args) => {
        if (args.block === 'pause') return host.settings.pause(z.object({ paused: z.boolean() }).parse(args.value).paused, 'tool')
        // Strip context_delivery since the main Session initiated the save itself.
        const { context_delivery: _delivery, ...saved } = await host.settings.save(
          args.block === 'source' ? `source:${args.source!}` : args.block,
          args.value,
          args.revision,
          'tool'
        )
        return saved
      }
    }),
    tool({
      name: 'orchestrator_policy_sync',
      description: promptText('superagent/app/tools/main/orchestrator_policy_sync.description'),
      schema: z.object({ source: z.string() }).strict(),
      execute: async (args) => {
        const before = host.store.settings().policy.sources[args.source]?.allowed ?? []
        const after = (await host.settings.sync(args.source)).allowed
        const names = (from: typeof after, without: typeof after) =>
          from.filter((item) => !without.some((other) => other.id === item.id)).map((item) => item.name ?? item.id)
        return { source: args.source, allowed: after.length, added: names(after, before), removed: names(before, after) }
      }
    }),
    tool({
      name: 'orchestrator_prompts_save',
      description: promptText('superagent/app/tools/main/orchestrator_prompts_save.description'),
      schema: z
        .object({
          config: PromptConfigSchema,
          baseRevision: z.number().int().min(0).optional().describe(promptText('superagent/app/tools/main/baseRevision')),
          preview: z.boolean().default(false).describe(promptText('superagent/app/tools/main/preview'))
        })
        .strict(),
      execute: async (args) => {
        if (args.preview) {
          const preview = host.prompts.preview(args.config)
          return {
            scope: preview.scope,
            previews: (['orchestrator', 'worker'] as const).map((role) => {
              const resource = `prompt-preview/${key(agent.id, role, preview[role])}`
              host.resources.pages.set(`${agent.id}:${resource}`, preview[role])
              return { role, chars: preview[role].length, read: resource }
            })
          }
        }
        if (args.baseRevision === undefined) throw new Error('Saving needs baseRevision, the revision the configuration edits')
        const { context_delivery: _delivery, ...saved } = await savePrompts(host, args.config, args.baseRevision, 'tool')
        return saved
      }
    })
  ]
}
