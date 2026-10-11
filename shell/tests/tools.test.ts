/** Spec §11: typing refusal matrix, click/scroll/navigate guards (through the guarded executor). */
import { describe, expect, it } from 'vitest';
import { runTool } from '../src/agent/executor';
import { classifyIntent } from '../src/agent/intent';
import { makeCtx, makeHost, SEARCH_BOX, snapshot } from './fakes';

const halt = (): void => undefined;

describe('typing refusal matrix', () => {
  it('refuses type_in_search outside RunningCommand', async () => {
    const { host, browser } = makeHost();
    const ctx = makeCtx('Guiding');
    ctx.grants.create(ctx.taskId, 'lofi beats');
    expect((await runTool('type_in_search', { text: 'lofi beats' }, ctx, host, halt)).error).toMatch(/RunningCommand/);
    expect(browser.typed).toEqual([]);
  });
  it('refuses without a grant', async () => {
    const { host, browser } = makeHost();
    expect((await runTool('type_in_search', { text: 'x y' }, makeCtx('RunningCommand'), host, halt)).error).toMatch(/no typing grant/);
    expect(browser.typed).toEqual([]);
  });
  it('refuses text that differs from the grant', async () => {
    const { host, browser } = makeHost();
    const ctx = makeCtx('RunningCommand');
    ctx.grants.create(ctx.taskId, 'lofi beats');
    expect((await runTool('type_in_search', { text: 'something else' }, ctx, host, halt)).error).toMatch(/differs/);
    expect(browser.typed).toEqual([]);
  });
  it('refuses a sensitive field even with a grant', async () => {
    const { host, browser } = makeHost();
    browser.snap = snapshot([{ ...SEARCH_BOX, sensitive: true }]);
    const ctx = makeCtx('RunningCommand');
    ctx.grants.create(ctx.taskId, 'lofi beats');
    expect((await runTool('type_in_search', { text: 'lofi beats' }, ctx, host, halt)).error).toMatch(/refused/);
    expect(browser.typed).toEqual([]);
  });
  it('types the granted title exactly once', async () => {
    const { host, browser } = makeHost();
    const ctx = makeCtx('RunningCommand');
    ctx.grants.create(ctx.taskId, 'lofi beats');
    expect((await runTool('type_in_search', { text: 'lofi beats' }, ctx, host, halt)).error).toBeUndefined();
    expect((await runTool('type_in_search', { text: 'lofi beats' }, ctx, host, halt)).error).toMatch(/already used/);
    expect(browser.typed).toEqual(['lofi beats']);
  });
  it('press_enter only right after a granted type_in_search', async () => {
    const { host, browser } = makeHost();
    expect((await runTool('press_enter', {}, makeCtx('RunningCommand'), host, halt)).error).toBeDefined();
    expect(browser.actions).not.toContain('enter');
  });
  it('grants come only from the user message intent ("findyt")', () => {
    expect(classifyIntent('findyt "Lofi Beats" on YouTube', ['findyt'])).toEqual({ kind: 'search_command', title: 'Lofi Beats' });
    expect(classifyIntent('findyt lofi beats', ['findyt'])).toEqual({ kind: 'search_command', title: 'lofi beats' });
    expect(classifyIntent('How do I register as a new voter?', ['findyt']).kind).toBe('guidance');
    expect(classifyIntent('findyt the register button', ['findyt']).kind).toBe('guidance');
  });
  it('"find X" and "search for X" are ghost guidance, never a typing grant', () => {
    expect(classifyIntent('find the register button', ['findyt'])).toMatchObject({ kind: 'guidance', locate: 'register' });
    expect(classifyIntent('search for "Lofi Beats" on YouTube', ['findyt']).kind).toBe('guidance');
    expect(classifyIntent('search for apply for learner licence', ['findyt'])).toMatchObject({ kind: 'guidance', locate: 'apply for learner licence' });
    expect(classifyIntent('find out how to register', ['findyt'])).toEqual({ kind: 'guidance', userAskedClick: false, userAskedScroll: false });
  });
});

describe('click / scroll / point guards', () => {
  it('click refused in guide mode unless the user asked', async () => {
    const { host, browser } = makeHost();
    expect((await runTool('click', { element_id: 'e2' }, makeCtx(), host, halt)).error).toMatch(/only allowed when the user asked/);
    expect(browser.actions.some((a) => a.startsWith('click'))).toBe(false);
  });
  it('click is telegraphed (move, pulse, hint) before acting, and refused on sensitive fields', async () => {
    const { host, browser, ghost } = makeHost();
    const ctx = makeCtx('Guiding', { userAskedClick: true });
    expect((await runTool('click', { element_id: 'e2' }, ctx, host, halt)).error).toBeUndefined();
    expect(ghost.log.slice(0, 3)).toEqual(['move:200,304', 'pulse', 'hint:Clicking here']);
    expect(browser.actions).toContain('click:200,220');
    expect((await runTool('click', { element_id: 'e3' }, ctx, host, halt)).error).toMatch(/sensitive/);
  });
  it('point_at on a sensitive field says the user must do it', async () => {
    const { host, ghost } = makeHost();
    const out = await runTool('point_at', { target_area: 'page', target_id: 'e3', hint: 'Enter the OTP here' }, makeCtx(), host, halt);
    expect(out.sensitive).toBe(true);
    expect(ghost.log.find((l) => l.startsWith('hint:'))).toMatch(/yourself/);
  });
  it('scroll is capped at one screen height', async () => {
    const { host, browser } = makeHost();
    await runTool('scroll', { direction: 'down', amount: 4000 }, makeCtx('Guiding', { userAskedScroll: true }), host, halt);
    expect(browser.actions).toContain('wheel:700');
  });
  it('navigate rejects a non-allowlisted host without touching the browser', async () => {
    const { host, browser } = makeHost();
    expect((await runTool('navigate', { url: 'https://evil.example.com/' }, makeCtx(), host, halt)).error).toMatch(/not allowlisted/);
    expect(browser.actions).toEqual([]);
  });
  it('navigate flies to the address bar and animates the URL before loading', async () => {
    const { host, browser, ghost } = makeHost();
    await runTool('navigate', { url: 'https://www.youtube.com/' }, makeCtx(), host, halt);
    expect(ghost.log[0]).toBe('move:420,60');
    expect(browser.actions).toEqual(['animate:https://www.youtube.com/', 'navigate:https://www.youtube.com/']);
  });
});
