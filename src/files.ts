// -*- coding: utf-8 -*-
/**
 * files.ts
 * Mobile Filesystem Protocol Adapter
 * =====================
 * Maps device file operations to the original Codex filesystem request methods.
 */
import type { CodexClient } from './codex';

// This adapter exposes the existing filesystem capabilities to the mobile engine.
// Paths are relative to a directory granted by the native platform.
export const FILE_TOOL = {
  type: 'function',
  name: 'mobile_files',
  description: 'Operate on files in the current authorized mobile directory. Use relative paths. Read and write UTF-8 text or base64 data. Inspect results after modifications.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['list', 'stat', 'read', 'write', 'mkdir', 'copy', 'move', 'delete'] },
      path: { type: 'string', description: 'Path relative to the current mobile directory; use an empty string for the directory itself.' },
      destination: { type: 'string', description: 'Relative destination for copy or move.' },
      content: { type: 'string', description: 'Contents for a write operation.' },
      encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Content encoding; defaults to utf8.' },
    },
    required: ['operation', 'path'],
    additionalProperties: false,
  },
};

/**
 * Resolve a relative path inside the selected native directory.
 *
 * Args:
 *     root (string): Absolute path granted by the native platform.
 *     relative (string): Requested relative path.
 * Returns:
 *     string: Absolute path within the granted root.
 * Raises:
 *     Error: The path contains traversal, an absolute prefix, or a null byte.
 */
export function resolveMobilePath(root: string, relative: string): string {
  const normalized = relative.replaceAll('\\', '/');
  // Require portable relative paths within the granted directory.
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0') || normalized.split('/').includes('..')) {
    throw new Error('文件路径必须位于当前授权目录内。');
  }
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  return root.replace(/\/$/, '') + (parts.length ? '/' + parts.join('/') : '');
}

/**
 * Execute a requested file operation using original Codex filesystem methods.
 *
 * Args:
 *     client (CodexClient): Client for the embedded upstream engine.
 *     root (string): Absolute authorized workspace path.
 *     args (object): Actual arguments emitted by the engine's file tool.
 * Returns:
 *     Promise<unknown>: Actual filesystem response delivered back to Codex.
 */
export async function executeFileOperation(client: CodexClient, root: string, args: Record<string, any>): Promise<unknown> {
  const path = resolveMobilePath(root, args.path);
  // Dispatch each supported operation to the corresponding original protocol method.
  switch (args.operation) {
    case 'list': return client.request('fs/readDirectory', { path }, root);
    case 'stat': return client.request('fs/getMetadata', { path }, root);
    case 'read': {
      const result = await client.request<{ dataBase64: string }>('fs/readFile', { path }, root);
      // Return binary data as base64 when the model explicitly requests that encoding.
      if (args.encoding === 'base64') return result;
      const bytes = Uint8Array.from(atob(result.dataBase64), (character) => character.charCodeAt(0));
      return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    }
    case 'write': {
      const bytes = new TextEncoder().encode(args.content ?? '');
      const dataBase64 = args.encoding === 'base64' ? args.content : btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
      return client.request('fs/writeFile', { path, dataBase64 }, root);
    }
    case 'mkdir': return client.request('fs/createDirectory', { path, recursive: true }, root);
    case 'copy':
    case 'move': {
      const destinationPath = resolveMobilePath(root, args.destination);
      // Preserve the directory grant and reject recursive copies into the source itself.
      if (path === root.replace(/\/$/, '') || destinationPath === path || destinationPath.startsWith(path + '/')) {
        throw new Error('请选择具体文件或子目录，并指定独立的目标路径。');
      }
      // Copy through the original engine before removing the source for a move.
      const result = await client.request('fs/copy', { sourcePath: path, destinationPath, recursive: true }, root);
      // Remove the source only after a successful copy response.
      if (args.operation === 'move') await client.request('fs/remove', { path, recursive: true, force: false }, root);
      return result;
    }
    case 'delete':
      // Preserve the selected root while allowing operations on its contents.
      if (path === root.replace(/\/$/, '')) throw new Error('请选择当前目录中的具体文件或子目录。');
      return client.request('fs/remove', { path, recursive: true, force: false }, root);
    default: throw new Error('当前系统操作无法识别。');
  }
}
