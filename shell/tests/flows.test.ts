/** Spec §10/§11 flows through AgentCore with a scripted planner: D, abstain, service down, B. */
import { describe, expect, it } from 'vitest';
import { AgentCore } from '../src/agent/core';
import type { PlannerDeps } from '../src/agent/planner';
import { RagUnavailableError } from '../src/rag/client';
import { assistantText, makeHost } from './fakes';
import { scripted } from './scripted';

describe('agent flows', () => {
  it('Flow D: search -> cited reply (Source + Last verified) -> point -> wait -> finish', async () => {
    const { host, events } = makeHost();
    const { factory, results } = scripted([
      { tool: 'search_docs', input: { query: 'register as new voter', org: 'ECI' } },
      { tool: 'reply', input: { text: 'Step 1: Fill **Form 6** if you are 18 years or above.', kind: 'fact', source_ids: ['S1'] } },
      { tool: 'point_at', input: { target_area: 'page', target_id: 'e2', hint: 'Click here to start' } },
      { tool: 'wait_for_user', input: { event: 'click', hint: "click 'Register'" } },
      { tool: 'finish', input: { message: 'You are on the form now.' } },
    ]);
    const agent = new AgentCore(host, factory);
    await agent.handleUserMessage('How do I register as a new voter?');
    expect(results.map((r) => r.error)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    const end = events.find((e) => e.t === 'assistant_end' && 'sources' in e && e.sources);
    expect(end && 'sources' in end ? end.sources?.[0].source_url : null).toBe('https://voters.eci.gov.in/guidelines/Form-6_en.pdf');
    expect(events).toContainEqual({ t: 'last_verified', date: '2026-10-10' });
    const statuses = events.filter((e) => e.t === 'status').map((e) => (e as { text: string | null }).text);
    expect(statuses).toEqual(
      expect.arrayContaining(['Thinking…', 'Searching official documents…', 'Found 1 relevant section', "Waiting for you to click 'Register'", null]),
    );
    expect(statuses.at(-1)).toBeNull();
    expect(agent.state).toBe('Idle');
  });

  it('model fails AFTER a cited answer (real log: "Model returned empty response"): no "cannot reach" card', async () => {
    const { host, events } = makeHost();
    const factory = (deps: PlannerDeps) => ({
      name: 'flaky',
      async run() {
        await deps.exec('search_docs', { query: 'minimum age to register as voter', org: 'ECI' });
        await deps.exec('reply', { text: 'You must be 18 years or above.', kind: 'fact', source_ids: ['S1'] });
        throw new Error('Model returned empty response');
      },
      cancel() {},
    });
    const agent = new AgentCore(host, factory);
    await agent.handleUserMessage('what should be my age to become a voter');
    expect(assistantText(events)).toContain('18 years or above');
    expect(events.some((e) => e.t === 'card' && (e as { kind: string }).kind === 'service_down')).toBe(false);
    expect(agent.state).toBe('Idle');
  });

  it('model fails BEFORE showing anything: the service-down card is still shown', async () => {
    const { host, events } = makeHost();
    const agent = new AgentCore(host, () => ({ name: 'down', async run() { throw new Error('fetch failed'); }, cancel() {} }));
    await agent.handleUserMessage('what should be my age to become a voter');
    expect(events.some((e) => e.t === 'card' && (e as { kind: string }).kind === 'service_down')).toBe(true);
  });

  it('abstain: shell card with config helpline, model text never shown, ghost idle', async () => {
    const { host, events, ghost } = makeHost({
      rag: { search: async () => ({ abstain: true, reason: 'out_of_scope', helpline: 'Voter Helpline 1950', results: [], corpus_last_updated: null }) },
    });
    const { factory, results } = scripted([
      { tool: 'search_docs', input: { query: 'which party should I vote for' } },
      { tool: 'reply', input: { text: 'Vote for party X!', kind: 'ui' } },
    ]);
    await new AgentCore(host, factory).handleUserMessage('Which party should I vote for?');
    expect(results).toHaveLength(1);
    expect(results[0].stop).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ t: 'card', kind: 'abstain', helpline: 'Voter Helpline 1950' }));
    expect(assistantText(events)).not.toContain('party X');
    expect(ghost.log.filter((l) => l.startsWith('move'))).toEqual([]);
  });

  it('service down: no factual reply, fallback card shown', async () => {
    const { host, events } = makeHost({
      rag: { search: async () => { throw new RagUnavailableError('down'); } },
    });
    const { factory } = scripted([
      { tool: 'search_docs', input: { query: 'form 6' } },
      { tool: 'reply', input: { text: 'Form 6 is for new voters.', kind: 'fact' } },
    ]);
    await new AgentCore(host, factory).handleUserMessage('What is Form 6?');
    expect(events).toContainEqual(expect.objectContaining({ t: 'card', kind: 'service_down', helpline: 'Voter Helpline 1950 | UIDAI 1947' }));
    expect(assistantText(events)).not.toContain('Form 6 is for');
  });

  it('ungrounded fact without search is rejected and never displayed', async () => {
    const { host, events } = makeHost();
    const { factory, results } = scripted([{ tool: 'reply', input: { text: 'The Aadhaar update fee is Rs. 50.', kind: 'fact' } }]);
    await new AgentCore(host, factory).handleUserMessage('What is the fee?');
    expect(results[0].error).toMatch(/source_ids/);
    expect(assistantText(events)).toBe('');
  });

  it('Flow B: "findyt <title>" -> grant, type once, Enter, grant dropped', async () => {
    const { host, browser, events } = makeHost();
    const { factory, results } = scripted([
      { tool: 'type_in_search', input: { text: 'Voter registration explained' } },
      { tool: 'press_enter', input: {} },
      { tool: 'finish', input: { message: 'Here are the results.' } },
    ]);
    const agent = new AgentCore(host, factory);
    await agent.handleUserMessage('findyt "Voter registration explained"');
    expect(results.map((r) => r.error)).toEqual([undefined, undefined, undefined]);
    expect(browser.typed).toEqual(['Voter registration explained']);
    expect(browser.actions).toContain('enter');
    expect(assistantText(events)).toContain('Searching YouTube for: **Voter registration explained**');
    expect(agent.grants.current).toBeNull();
  });
});
