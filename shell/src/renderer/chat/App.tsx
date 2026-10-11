/**
 * Chat panel (spec 7). The renderer can only send ChatCommand and receive
 * ChatEvent; it never talks to the network or the agent directly.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { ChatApi } from '../../preload/chat';
import { Message } from './Message';
import { initialState, reduce } from './store';

declare global {
  interface Window {
    chat: ChatApi;
  }
}

const STATE_LABEL: Record<string, string> = {
  Idle: 'Idle',
  Guiding: 'Guiding',
  AwaitingUser: 'Waiting for you',
  RunningCommand: 'Running command',
  Halted: 'Halted',
};

const STARTERS = [
  'How do I register as a new voter?',
  'Which documents are needed to update my address?',
  'Open the official portal',
];

export function App() {
  const [s, dispatch] = useReducer(reduce, initialState);
  const [draft, setDraft] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    window.chat.send({ t: 'collapse', collapsed: next });
  };
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const off = window.chat.onEvent(dispatch);
    const offFocus = window.chat.onFocusInput(() => inputRef.current?.focus());
    window.chat.ready();
    return () => {
      off();
      offFocus();
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [s.items, s.status, s.waitingFirstToken]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.chat.send({ t: 'esc' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const send = (text: string): void => {
    const value = text.trim();
    if (!value) return;
    window.chat.send({ t: 'send', text: value });
    setDraft('');
  };
  const openUrl = (url: string): void => window.chat.send({ t: 'open_source', url });
  const busy = s.state !== 'Idle' && s.state !== 'Halted';

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <header onDoubleClick={toggle}>
        <div className="brand">
          <span className={`orb st-${s.state}`} />
          <span>Guide</span>
          <span className="brand-sub">Official Docs</span>
        </div>
        <div className="head-right">
          <span className={`chip-state st-${s.state}`}>{STATE_LABEL[s.state]}</span>
          <button className="icon" onClick={toggle} title={`${collapsed ? 'Expand' : 'Collapse'} (hide/show: Ctrl+Shift+Space)`}>
            {collapsed ? '▾' : '▴'}
          </button>
        </div>
      </header>
      {collapsed && s.status && <div className="mini-status">{s.status}</div>}
      {s.service !== 'ok' && s.service !== 'unknown' && (
        <div className={`service svc-${s.service}`}>
          {s.service === 'warming_up' ? 'Knowledge base is warming up…' : 'Knowledge base is offline. Answers are unavailable.'}
        </div>
      )}

      <div className="messages" ref={listRef}>
        {s.items.length === 0 && (
          <div className="empty">
            <p>Ask a question or request guidance. I answer only from official documents and show you where to click.</p>
            <div className="starters">
              {STARTERS.map((q) => (
                <button key={q} onClick={() => send(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {s.items.map((item) => (
          <Message key={item.id} item={item} onOpen={openUrl} />
        ))}
        {s.waitingFirstToken && (
          <div className="row assistant">
            <div className="bubble assistant typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        {s.status && (
          <div className="subtitle">
            <span className="pulse-dot" />
            {s.status}
          </div>
        )}
      </div>

      {s.lastVerified && <div className="verified">Last verified: {s.lastVerified}</div>}
      <footer>
        <textarea
          ref={inputRef}
          value={draft}
          rows={2}
          placeholder={busy ? 'Press Esc twice to stop…' : 'Ask a question, "find <service>", or "findyt <video title>"'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
        />
        <div className="actions">
          {busy && (
            <button className="stop" onClick={() => window.chat.send({ t: 'kill' })} title="Stop (Esc Esc)">
              ⏹
            </button>
          )}
          <button className="send" onClick={() => send(draft)} disabled={!draft.trim()}>
            ➤
          </button>
        </div>
      </footer>
    </div>
  );
}
