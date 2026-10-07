// -*- coding: utf-8 -*-
/**
 * types.ts
 * Mobile Session and System Contracts
 * =====================
 * Defines shared contracts for conversations and device-local file operations.
 */

/**
 * An authorized device directory.
 * The identifier references a native grant or the app's private workspace.
 */
export interface Workspace {
  id: string;
  name: string;
  kind: 'private' | 'selected';
  path: string;
}

/**
 * A conversation item.
 * Tool items preserve the actual arguments and execution status.
 */
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  status?: 'running' | 'completed' | 'failed';
}

/**
 * A saved mobile conversation.
 * Remote session identifiers support continuation of the same agent context.
 */
export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  remoteId?: string;
  workspaceId: string;
  messages: Message[];
}

// File paths are relative to the selected workspace and use forward slashes.
// Mutating operations receive authorization before invoking the native executor.
export type SystemOperation = 'list' | 'stat' | 'read' | 'write' | 'mkdir' | 'copy' | 'move' | 'delete';

/**
 * A system operation requested by the agent.
 * Content is UTF-8 text or base64 data; destinations share the same workspace.
 */
export interface SystemRequest {
  operation: SystemOperation;
  path: string;
  destination?: string;
  content?: string;
  encoding?: 'utf8' | 'base64';
}

/**
 * File metadata returned by the native executor.
 * Size is measured in bytes and modification time in Unix milliseconds.
 */
export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
  modifiedAt: number;
}

/**
 * An operation result.
 * The agent receives only results produced by the actual device operation.
 */
export interface SystemResult {
  entries?: FileEntry[];
  entry?: FileEntry;
  content?: string;
  encoding?: string;
  path?: string;
  destination?: string;
  bytes?: number;
  deleted?: boolean;
}
