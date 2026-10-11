/** State machine (spec 8.8) and per-state tool permissions (spec 3, 8.4). */
import type { AgentState } from '../shared/ipc';

export type Trigger =
  | 'user_message'
  | 'search_command'
  | 'wait_entered'
  | 'user_acted'
  | 'results_shown'
  | 'finish'
  | 'halt';

export type ToolName =
  | 'search_docs'
  | 'reply'
  | 'point_at'
  | 'click'
  | 'scroll'
  | 'open_tab'
  | 'switch_tab'
  | 'navigate'
  | 'type_in_search'
  | 'press_enter'
  | 'wait_for_user'
  | 'finish';

const TABLE: Record<Trigger, Partial<Record<AgentState, AgentState>>> = {
  user_message: { Idle: 'Guiding', Halted: 'Guiding', Guiding: 'Guiding', AwaitingUser: 'Guiding' },
  search_command: { Idle: 'RunningCommand', Guiding: 'RunningCommand', Halted: 'RunningCommand', AwaitingUser: 'RunningCommand' },
  wait_entered: { Guiding: 'AwaitingUser', RunningCommand: 'AwaitingUser' },
  user_acted: { AwaitingUser: 'Guiding' },
  results_shown: { RunningCommand: 'Guiding' },
  finish: { Guiding: 'Idle', AwaitingUser: 'Idle', RunningCommand: 'Idle' },
  halt: { Idle: 'Halted', Guiding: 'Halted', AwaitingUser: 'Halted', RunningCommand: 'Halted', Halted: 'Halted' },
};

export class StateMachine {
  private current: AgentState = 'Idle';
  constructor(private readonly onChange?: (state: AgentState) => void) {}

  get state(): AgentState {
    return this.current;
  }

  apply(trigger: Trigger): AgentState {
    const next = TABLE[trigger][this.current];
    if (next && next !== this.current) {
      this.current = next;
      this.onChange?.(next);
    }
    return this.current;
  }

  /** Hard reset used when a new user message arrives after Halted. */
  reset(): void {
    if (this.current !== 'Idle') {
      this.current = 'Idle';
      this.onChange?.('Idle');
    }
  }

  allows(tool: ToolName, userAskedAction: boolean): { ok: true } | { ok: false; reason: string } {
    const s = this.current;
    if (s === 'Halted') return { ok: false, reason: 'the task was stopped (Halted); nothing may run' };
    if (s === 'Idle') return { ok: false, reason: 'no task is running' };
    if (tool === 'type_in_search' || tool === 'press_enter') {
      return s === 'RunningCommand'
        ? { ok: true }
        : { ok: false, reason: `${tool} is only allowed in RunningCommand (a "findyt <title>" YouTube search command); current state ${s}` };
    }
    if ((tool === 'click' || tool === 'scroll') && s !== 'RunningCommand' && !userAskedAction) {
      return { ok: false, reason: `${tool} is only allowed when the user asked for it. Use point_at to show the user instead` };
    }
    return { ok: true };
  }
}
