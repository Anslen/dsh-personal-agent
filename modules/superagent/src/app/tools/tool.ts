import { promptText, renderPrompt } from "../../../../../prompts/index.mjs";
/** Shared tool primitives and schemas for the main and executor Sessions. */
import { z } from 'zod'
import { IM_WORDS, wordCount } from '../../infra/text.ts'
import { resourceGrammar } from '../resources.ts'

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  schema: S
  execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown>
}
export type RegisterTool = <S extends z.ZodType>(name: string, description: string, schema: S, execute: Tool<S>['execute']) => void
export const tool = <S extends z.ZodType>(definition: Tool<S>): Tool => definition as unknown as Tool

/** Human-facing acknowledgement text, constrained to `IM_WORDS` regardless of which channel it is posted to. */
export const AcknowledgementSchema = z.string().trim().min(1)
  .refine(text => wordCount(text) <= IM_WORDS, `An acknowledgement has at most ${IM_WORDS} words (Chinese uses word segmentation); write one short sentence.`)
/**
 * Builds the `orchestrator_read` tool, scoping allowed resource patterns to the main Session or to an
 * Executor Session (which may read only its own ticket and messages that reached it).
 */
export function readTool(description: string, executor: boolean,
  read: (resource: string, offset: number, limit: number | undefined, signal: AbortSignal) => Promise<unknown>): Tool {
  return tool({
    name: 'orchestrator_read',
    description,
    schema: z
      .object({
        resource: z
          .string()
          .min(1)
          .describe(renderPrompt('superagent/app/tools/tool/resource', { p0: resourceGrammar(executor) })),
        offset: z.number().int().min(0).default(0).describe(promptText('superagent/app/tools/tool/offset')),
        limit: z.number().int().min(1).max(8000).optional().describe(promptText('superagent/app/tools/tool/limit'))
      })
      .strict(),
    execute: async (args, signal) => read(args.resource, args.offset, args.limit, signal)
  })
}
