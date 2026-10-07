// -*- coding: utf-8 -*-
/**
 * session.test.ts
 * Original Protocol Transcript Verification
 * =====================
 * Verifies stream reconciliation, execution failures, and optimistic message deduplication.
 */
import { describe, expect, it } from 'vitest';

import { projectItem, reduceEvent } from '../src/session';

// Engine deltas can arrive before their authoritative completed item.
describe('original Codex event projection', () => {
  it('reconciles streamed text with the authoritative completed item', () => {
    let transcript = reduceEvent([], { method: 'item/agentMessage/delta', params: { itemId: 'item-1', delta: 'Hello' } });
    transcript = reduceEvent(transcript, { method: 'item/agentMessage/delta', params: { itemId: 'item-1', delta: ', Codex' } });
    transcript = reduceEvent(transcript, { method: 'item/completed', params: { item: { id: 'item-1', type: 'agentMessage', text: 'Hello, Codex.' } } });
    expect(transcript).toEqual([{ id: 'item-1', role: 'assistant', text: 'Hello, Codex.' }]);
  });

  it('replaces the optimistic user message with its original item', () => {
    const transcript = reduceEvent([{ id: 'local-1', role: 'user', text: 'Organize files' }], {
      method: 'item/started', params: { item: { id: 'server-1', type: 'userMessage', content: [{ type: 'text', text: 'Organize files' }] } },
    });
    expect(transcript).toHaveLength(1);
    expect(transcript[0].id).toBe('server-1');
  });

  it('displays declined commands as failed execution', () => {
    expect(projectItem({ id: 'command-1', type: 'commandExecution', command: 'mv report.csv archive/', status: 'declined' })?.status).toBe('failed');
  });

  it('preserves a failed tool result after its delivery completes', () => {
    expect(projectItem({ id: 'file-1', type: 'dynamicToolCall', tool: 'mobile_files', status: 'completed', success: false })?.status).toBe('failed');
  });
});
