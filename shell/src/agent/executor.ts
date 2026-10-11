/**
 * Guarded execution (spec 8.3/8.4). Both planners call tools ONLY through
 * runTool(): state check -> caps -> schema validation -> status subtitle ->
 * tool.execute (which enforces its own guardrails) -> rejection accounting.
 */
import { redactDeep } from '../rag/redact';
import type { ToolName } from './stateMachine';
import { STATUS_RETRY, statusForTool } from './status';
import { ALL_TOOLS } from './tools';
import type { Host, TaskContext, ToolDef, ToolOutput } from './types';
import { AbortedError } from './types';

export const MAX_TOOL_CALLS = 12;
export const MAX_CONSECUTIVE_REJECTIONS = 3;

export type HaltFn = (reason: 'tool_cap' | 'rejections' | 'overlay' | 'time_cap' | 'error', detail?: string) => void;

const BY_NAME = new Map<string, ToolDef>(ALL_TOOLS.map((tool) => [tool.name, tool]));

export function toolByName(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

export async function runTool(
  name: string,
  rawInput: unknown,
  ctx: TaskContext,
  host: Host,
  halt: HaltFn,
): Promise<ToolOutput> {
  if (ctx.stopped || ctx.finished) return { stop: true, error: 'the task already ended' };
  const tool = BY_NAME.get(name);
  if (!tool) return { error: `unknown tool "${name}"` };

  ctx.toolCalls += 1;
  const cap = ctx.toolCap ?? MAX_TOOL_CALLS;
  if (ctx.toolCalls > cap) {
    halt('tool_cap');
    return { stop: true, error: `tool call cap (${cap}) reached` };
  }

  const userAsked =
    tool.name === 'click' ? ctx.userAskedClick : tool.name === 'scroll' ? ctx.userAskedScroll : false;
  const allowed = ctx.machine.allows(tool.name, userAsked);
  let output: ToolOutput;
  const started = host.now();

  if (!allowed.ok) {
    output = { error: allowed.reason };
  } else {
    const parsed = tool.schema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      output = { error: `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}` };
    } else {
      const status = statusForTool(tool.name, (parsed.data ?? {}) as Record<string, unknown>, {
        tabTitle: (id) => host.browser.listTabs().find((t) => t.id === id)?.title ?? null,
        elementName: () => null,
      });
      if (status !== undefined && tool.name !== 'search_docs') host.chat.emit({ t: 'status', text: status });
      if (tool.name === 'search_docs') host.chat.emit({ t: 'status', text: status ?? null });
      try {
        output = await tool.execute(parsed.data, ctx, host);
      } catch (error) {
        if (error instanceof AbortedError || ctx.signal.aborted) {
          output = { stop: true, error: 'stopped by the user' };
        } else if (/overlay/i.test(String(error))) {
          halt('overlay', String(error));
          output = { stop: true, error: String(error) };
        } else {
          output = { error: `tool failed: ${String(error instanceof Error ? error.message : error)}` };
        }
      }
    }
  }

  const rejected = typeof output.error === 'string' && !output.stop;
  if (rejected) {
    ctx.consecutiveRejections += 1;
    host.chat.emit({ t: 'status', text: STATUS_RETRY });
    if (ctx.consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
      halt('rejections', output.error);
      output = { ...output, stop: true };
    }
  } else if (!output.error) {
    ctx.consecutiveRejections = 0;
    ctx.lastSuccessfulTool = tool.name as ToolName;
  }
  if (output.stop) ctx.stopped = true;

  host.logger.info('tool', tool.name, {
    taskId: ctx.taskId,
    state: ctx.machine.state,
    ok: !output.error,
    error: output.error,
    stop: Boolean(output.stop),
    ms: host.now() - started,
    input: redactDeep(rawInput) as Record<string, unknown>,
  });
  return output;
}
