// -*- coding: utf-8 -*-
/**
 * session.ts
 * Codex Session Event Projection
 * =====================
 * Projects original app-server events into the mobile conversation interface.
 */
import type { RpcEvent } from './codex';
import type { Message } from './types';

/**
 * Convert an original conversation item to a mobile display item.
 *
 * Args:
 *     item (object): Original app-server thread item.
 * Returns:
 *     Message | null: Display item or null for an unsupported item type.
 */
export function projectItem(item: Record<string, any>): Message | null {
  // Display user text while retaining the original item identifier.
  if (item.type === 'userMessage') {
    return { id: item.id, role: 'user', text: (item.content ?? []).map((part: any) => part.text ?? '').join('\n') };
  }
  // Display actual generated text and plan content.
  if (item.type === 'agentMessage' || item.type === 'plan') {
    return { id: item.id, role: 'assistant', text: item.text ?? '' };
  }
  // Keep execution status distinct from the model's response text.
  if (['commandExecution', 'fileChange', 'dynamicToolCall', 'mcpToolCall', 'webSearch'].includes(item.type)) {
    const text = item.command ?? item.tool ?? item.action?.query ?? '更新文件';
    const status = item.status === 'inProgress' ? 'running' : item.success === false || ['failed', 'declined', 'cancelled'].includes(item.status) ? 'failed' : 'completed';
    return { id: item.id, role: 'tool', text, status };
  }
  return null;
}

/**
 * Apply one original app-server notification to the visible transcript.
 *
 * Args:
 *     messages (Message[]): Current projected transcript.
 *     event (RpcEvent): Original engine notification.
 * Returns:
 *     Message[]: Updated transcript preserving authoritative completed items.
 */
export function reduceEvent(messages: Message[], event: RpcEvent): Message[] {
  const { method, params } = event;
  // Stream text into the corresponding original engine item.
  if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
    const existing = messages.find((message) => message.id === params.itemId);
    // Create a display item when a delta precedes its item-started event.
    if (!existing) return [...messages, { id: params.itemId, role: 'assistant', text: params.delta }];
    return messages.map((message) => message.id === params.itemId ? { ...message, text: message.text + params.delta } : message);
  }
  // Replace streamed content with the engine's authoritative item representation.
  if (method === 'item/started' || method === 'item/completed') {
    const item = projectItem(params.item);
    // Preserve the transcript for item types without a display representation.
    if (!item) return messages;
    const index = messages.findIndex((message) => message.id === item.id);
    // Replace the optimistic user item with the actual server item.
    if (item.role === 'user' && index === -1) {
      const optimistic = messages.findIndex((message) => message.id.startsWith('local-') && message.text === item.text);
      // Deduplicate the user's locally submitted text.
      if (optimistic !== -1) return messages.map((message, i) => i === optimistic ? item : message);
    }
    return index === -1 ? [...messages, item] : messages.map((message, i) => i === index ? item : message);
  }
  return messages;
}
