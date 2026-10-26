// -*- coding: utf-8 -*-
/**
 * codex.ts
 * Original Codex Protocol Client
 * =====================
 * Connects the mobile interface to the embedded upstream app-server protocol.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

import type { Workspace } from './types';

/**
 * Original app-server envelope.
 * Requests retain upstream method names and parameters across the native bridge.
 */
export interface RpcEvent {
  id?: string | number;
  method: string;
  params: Record<string, any>;
}

/**
 * Native Codex host contract.
 * The native host embeds Rust in the same mobile application process.
 */
interface NativeHost {
  start(): Promise<{ result?: { workspace: string; shellAvailable: boolean; bridgeApiVersion: number; activeThreadId?: string; resumeThreadId?: string }; error?: { message: string } }>;
  request(options: { json: string }): Promise<{ result?: any; error?: { message: string } }>;
  poll(): Promise<{ events: RpcEvent[] }>;
  selectDirectory(): Promise<Workspace>;
  openUrl(options: { url: string }): Promise<void>;
}

const host = registerPlugin<NativeHost>('CodexRuntime');

/**
 * Embedded app-server client.
 * Native calls preserve both CLI authentication methods and actual engine events.
 */
export class CodexClient {
  shellAvailable = false;
  resumeThreadId = '';
  private nextId = 1;
  private polling = false;
  private stopped = true;
  private startupId = 0;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private listener?: (event: RpcEvent) => void;

  /**
   * Start the device-local Codex engine and event delivery.
   *
   * Args:
   *     listener (Function): Consumer of original app-server events.
   * Returns:
   *     Promise<Workspace>: Private device workspace created by the native host.
   */
  async start(listener: (event: RpcEvent) => void): Promise<Workspace> {
    // Keep browser previews explicit about their execution capability.
    if (!Capacitor.isNativePlatform()) {
      throw new Error('当前为界面预览。系统操作需要安装包含 Codex 内核的手机应用。');
    }
    const startupId = ++this.startupId;
    this.stopped = true;
    clearTimeout(this.pollTimer);
    this.listener = listener;
    const response = await host.start();
    // Ignore a native startup superseded by detachment or a newer attachment.
    if (startupId !== this.startupId) throw new DOMException('Codex client startup was detached.', 'AbortError');
    // Surface native startup errors before enabling task submission.
    if (response.error) throw new Error(response.error.message);
    // Require the native tool and task lifecycle contract packaged with this interface.
    if (response.result?.bridgeApiVersion !== 2) throw new Error('手机界面与原生内核版本不匹配，请重新构建并安装完整应用。');
    this.shellAvailable = response.result!.shellAvailable;
    this.resumeThreadId = response.result!.resumeThreadId || response.result!.activeThreadId || '';
    this.stopped = false;
    void this.poll();
    return { id: 'private', name: '应用文件夹', kind: 'private', path: response.result!.workspace };
  }

  /**
   * Dispatch an original app-server request.
   *
   * Args:
   *     method (string): Original protocol method name.
   *     params (object): Original protocol request parameters.
   *     workspaceRoot (string | undefined): Native directory boundary for a filesystem request.
   * Returns:
   *     Promise<T>: Result produced by the embedded Codex engine.
   */
  async request<T = any>(method: string, params: Record<string, unknown> = {}, workspaceRoot?: string): Promise<T> {
    // The native host consumes the directory boundary before upstream protocol dispatch.
    const response = await host.request({ json: JSON.stringify({ id: this.nextId++, method, params, mobileWorkspaceRoot: workspaceRoot }) });
    // Propagate engine errors while preserving the original successful response.
    if (response.error) throw new Error(response.error.message);
    return response.result as T;
  }

  /**
   * Resolve a server-initiated approval, question, or tool request.
   *
   * Args:
   *     id (string | number): Identifier emitted by the engine.
   *     result (unknown): Response matching the original request schema.
   * Returns:
   *     Promise<void>: Completion of native response dispatch.
   */
  async respond(id: string | number, result: unknown): Promise<void> {
    const response = await host.request({ json: JSON.stringify({ id, result }) });
    // Surface dispatch failures so an approval remains available for retry.
    if (response.error) throw new Error(response.error.message);
  }

  /**
   * Reject a server request unsupported by the current interface.
   *
   * Args:
   *     id (string | number): Identifier emitted by the engine.
   *     message (string): Reason for rejecting the request.
   * Returns:
   *     Promise<void>: Completion of error delivery to the engine.
   */
  async reject(id: string | number, message: string): Promise<void> {
    const response = await host.request({ json: JSON.stringify({ id, error: { code: -32601, message } }) });
    // Keep a failed rejection visible so the request can be retried.
    if (response.error) throw new Error(response.error.message);
  }

  /**
   * Resolve an original mobile file request through the native executor.
   *
   * Args:
   *     id (string | number): Original pending tool request identifier.
   *     allow (boolean): User decision for this specific original request.
   * Returns:
   *     Promise<void>: Native execution and original tool-response delivery complete.
   */
  async resolveFile(id: string | number, allow: boolean): Promise<void> {
    const response = await host.request({ json: JSON.stringify({ id, mobileFileDecision: allow }) });
    // Preserve a failed native response for an explicit retry by the interface.
    if (response.error) throw new Error(response.error.message);
  }

  /**
   * Select a directory through the platform's permission interface.
   *
   * Args:
   *     None.
   * Returns:
   *     Promise<Workspace>: Directory granted by the operating system.
   */
  async selectDirectory(): Promise<Workspace> { return host.selectDirectory(); }

  /**
   * Open the upstream authorization URL in the platform browser.
   *
   * Args:
   *     url (string): HTTPS authorization URL returned by Codex.
   * Returns:
   *     Promise<void>: Completion of browser presentation.
   */
  async openUrl(url: string): Promise<void> { await host.openUrl({ url }); }

  /**
   * Stop event delivery when the interface is detached.
   *
   * Args:
   *     None.
   * Returns:
   *     void: Event polling stops while the native engine retains its state.
   */
  stop(): void {
    this.startupId++;
    this.stopped = true;
    this.listener = undefined;
    clearTimeout(this.pollTimer);
  }

  /**
   * Poll native events without overlapping bridge requests.
   *
   * Args:
   *     None.
   * Returns:
   *     Promise<void>: Events are delivered in their original order.
   */
  private async poll(): Promise<void> {
    // Prevent overlapping polling loops during interface initialization.
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      // Drain every actual event returned by the device-local runtime.
      const { events } = await host.poll();
      // Deliver notifications and server requests to the original protocol consumer.
      for (const event of events) this.listener?.(event);
    } catch (error) {
      this.listener?.({ method: 'mobile/error', params: { message: String(error) } });
    } finally {
      this.polling = false;
      // Continue event delivery while the interface owns this client.
      if (!this.stopped) this.pollTimer = setTimeout(() => void this.poll(), 100);
    }
  }
}
