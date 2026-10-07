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
  start(): Promise<{ result?: { workspace: string; shellAvailable: boolean }; error?: { message: string } }>;
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
  private nextId = 1;
  private polling = false;
  private stopped = true;
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
    this.listener = listener;
    const response = await host.start();
    // Surface native startup errors before enabling task submission.
    if (response.error) throw new Error(response.error.message);
    this.shellAvailable = response.result!.shellAvailable;
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
   * Returns:
   *     Promise<T>: Result produced by the embedded Codex engine.
   */
  async request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await host.request({ json: JSON.stringify({ id: this.nextId++, method, params }) });
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
    await host.request({ json: JSON.stringify({ id, error: { code: -32601, message } }) });
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
  stop(): void { this.stopped = true; this.listener = undefined; }

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
      if (!this.stopped) setTimeout(() => void this.poll(), 100);
    }
  }
}
