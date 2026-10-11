/**
 * Ports between the agent core and the outside world. Tools talk ONLY to these
 * interfaces, so guardrails are unit-testable without Electron.
 */
import type { ElementInfo } from '../bridge/cdp';
import type { RagClient } from '../rag/client';
import type { ChatEvent, GhostRect, TabInfo } from '../shared/ipc';
import type { PageEvent, PageSnapshot } from '../shared/page';
import type { Chunk } from './grounding';
import type { StateMachine, ToolName } from './stateMachine';
import type { GrantStore } from './typingGrant';

export type Point = { x: number; y: number };

/** Browser shell (tab manager + CDP of the active tab). Coordinates are overlay-local DIP. */
export interface BrowserPort {
  snapshot(): Promise<PageSnapshot | null>;
  elementInfo(elementId: string): Promise<ElementInfo>;
  /** Overlay-local origin of the active page view (page CSS px + origin = overlay px). */
  pageOrigin(): Point;
  pageSize(): { width: number; height: number };
  /** Toolbar element rect in overlay-local px, from the toolbar renderer's data-ghost-id report. */
  toolbarRect(ghostId: string): GhostRect | null;
  listTabs(): TabInfo[];
  activeTabId(): string | null;
  maxTabs(): number;
  openTab(url: string): Promise<string>;
  switchTab(id: string): void;
  navigate(url: string): Promise<void>;
  /** Visual only: animate the URL appearing in the address bar. Never keystrokes. */
  animateUrl(url: string, ms: number): void;
  click(pageX: number, pageY: number): Promise<void>;
  wheel(pageX: number, pageY: number, deltaY: number): Promise<void>;
  /** Smoothly bring an element to the middle of the viewport. Reveals only: never clicks. */
  scrollIntoView(elementId: string): Promise<boolean>;
  /** Best element on the whole page whose visible label matches the text (tags it with an id). */
  findByText(query: string): Promise<{ id: string; name: string; score: number } | null>;
  /** Clickable labels that share words with the query ("did you mean ..."). */
  similarLabels(query: string): Promise<string[]>;
  /**
   * Visible element matching a CSS selector (catalog routes), tagged with an id.
   * With expectedName, the element's label must contain it, so a stale selector
   * that now hits a different element is rejected.
   */
  findBySelector(css: string, expectedName?: string): Promise<{ id: string; name: string; score: number } | null>;
  focusSearch(elementId: string): Promise<boolean>;
  insertText(text: string): Promise<void>;
  searchValue(elementId: string): Promise<string | null>;
  pressEnter(): Promise<void>;
  /** Resolve with the next matching page event from the user, or null on timeout/abort. */
  waitForEvent(event: WaitEvent, timeoutMs: number, signal: AbortSignal): Promise<PageEvent | null>;
}

export type WaitEvent = 'focus' | 'click' | 'input' | 'navigation' | 'any';

export interface GhostPort {
  readonly alive: boolean;
  /** True while the ghost is hidden on purpose because the user switched to another app. */
  readonly hiddenByUser?: boolean;
  move(x: number, y: number, ms: number): void;
  pulse(x: number, y: number): void;
  ripple(x: number, y: number): void;
  hint(text: string, x: number, y: number): void;
  hide(): void;
}

export interface ChatPort {
  emit(event: ChatEvent): void;
}

export interface LoggerPort {
  info(kind: string, message: string, data?: Record<string, unknown>): void;
  warn(kind: string, message: string, data?: Record<string, unknown>): void;
  error(kind: string, message: string, data?: Record<string, unknown>): void;
}

export interface Host {
  browser: BrowserPort;
  ghost: GhostPort;
  chat: ChatPort;
  rag: Pick<RagClient, 'search'>;
  logger: LoggerPort;
  config: { allowedHosts: string[]; helplineFallback: string };
  /** Injected so tests can run without real waiting. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
}

/** Everything one task (one user message + its planner run) owns. */
export interface TaskContext {
  taskId: string;
  userMessage: string;
  userAskedClick: boolean;
  userAskedScroll: boolean;
  /** S1, S2, ... -> chunk (spec 8.3: ctx.chunks). Persists across turns in a session. */
  chunks: Map<string, Chunk>;
  /** Hosts of source_urls returned by search_docs in this task (allowlist, spec 6.5). */
  sourceHosts: Set<string>;
  corpusLastUpdated: string | null;
  searchCalls: number;
  toolCalls: number;
  /** Per-task tool call cap; defaults to MAX_TOOL_CALLS. A catalog route raises it to fit its steps. */
  toolCap?: number;
  consecutiveRejections: number;
  lastSuccessfulTool: ToolName | null;
  /** Set when the shell has taken over (abstain card, service down, finish, halt). */
  stopped: boolean;
  finished: boolean;
  signal: AbortSignal;
  machine: StateMachine;
  grants: GrantStore;
  ghostAt: Point | null;
  /** True once the user has seen a real answer or pointer (reply / point_at succeeded). */
  shownToUser?: boolean;
}

export type ToolOutput = Record<string, unknown> & { error?: string; stop?: boolean };

export interface ToolDef<I = any> {
  name: ToolName;
  description: string;
  /** zod schema; converted to JSON schema for both planners. */
  schema: import('zod').ZodType<I>;
  execute(input: I, ctx: TaskContext, host: Host): Promise<ToolOutput>;
}

export class AbortedError extends Error {
  constructor() {
    super('aborted');
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortedError();
}
