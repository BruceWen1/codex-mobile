// -*- coding: utf-8 -*-
/**
 * codex.test.ts
 * Native Protocol Client Lifecycle Verification
 * =====================
 * Verifies startup cancellation, polling ownership, and native dispatch failures.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { CodexClient } from '../src/codex';

/**
 * Create isolated native bridge method mocks.
 *
 * Args:
 *     None.
 * Returns:
 *     object: Native methods for isolated protocol verification.
 */
const nativeHost = vi.hoisted(function createNativeHost() {
  return { start: vi.fn(), request: vi.fn(), poll: vi.fn(), selectDirectory: vi.fn(), openUrl: vi.fn(), nativePlatform: vi.fn() };
});
/**
 * Provide the isolated native bridge to the actual protocol client.
 *
 * Args:
 *     None.
 * Returns:
 *     object: Capacitor contract backed by isolated native method mocks.
 */
vi.mock('@capacitor/core', function provideNativeBridge() {
  return { Capacitor: { isNativePlatform: nativeHost.nativePlatform }, registerPlugin: vi.fn().mockReturnValue(nativeHost) };
});

let client: CodexClient;

/**
 * Reset the isolated native host before each lifecycle scenario.
 *
 * Args:
 *     None.
 * Returns:
 *     void: Native calls and timers are isolated for the next scenario.
 */
function resetHost(): void {
  vi.useFakeTimers();
  vi.resetAllMocks();
  nativeHost.nativePlatform.mockReturnValue(true);
  nativeHost.start.mockResolvedValue({ result: { workspace: '/workspace', shellAvailable: true, bridgeApiVersion: 2 } });
  nativeHost.poll.mockResolvedValue({ events: [] });
  nativeHost.request.mockResolvedValue({ result: null });
  client = new CodexClient();
}

/**
 * Detach the client and restore real timers after each scenario.
 *
 * Args:
 *     None.
 * Returns:
 *     void: Pending polling timers have been released.
 */
function releaseHost(): void {
  client.stop();
  vi.useRealTimers();
}

beforeEach(resetHost);
afterEach(releaseHost);

/**
 * Verify that a native startup completing after detachment remains cancelled.
 *
 * Args:
 *     None.
 * Returns:
 *     Promise<void>: Late startup leaves native polling stopped.
 */
async function verifyDetachedStartup(): Promise<void> {
  let finish!: (value: unknown) => void;
  /**
   * Retain completion of the isolated native startup.
   *
   * Args:
   *     resolve (Function): Completion callback for native startup.
   * Returns:
   *     void: The test owns the timing of the original startup response.
   */
  nativeHost.start.mockReturnValue(new Promise(function retainStartup(resolve) { finish = resolve; }));
  const startup = client.start(vi.fn());
  const cancelled = expect(startup).rejects.toMatchObject({ name: 'AbortError' });
  client.stop();
  finish({ result: { workspace: '/workspace', shellAvailable: true } });
  await cancelled;
  await vi.advanceTimersByTimeAsync(500);
  expect(nativeHost.poll).not.toHaveBeenCalled();
}

/**
 * Verify that reattachment retains a single native polling loop.
 *
 * Args:
 *     None.
 * Returns:
 *     Promise<void>: Polling continues once per interval and stops after detachment.
 */
async function verifyPollingOwnership(): Promise<void> {
  await client.start(vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  await client.start(vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(nativeHost.poll).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(100);
  expect(nativeHost.poll).toHaveBeenCalledTimes(3);
  client.stop();
  await vi.advanceTimersByTimeAsync(500);
  expect(nativeHost.poll).toHaveBeenCalledTimes(3);
}

/**
 * Verify that the native host can report a rejected server-response dispatch.
 *
 * Args:
 *     None.
 * Returns:
 *     Promise<void>: The caller receives the actual native failure.
 */
async function verifyRejectionFailure(): Promise<void> {
  nativeHost.request.mockResolvedValue({ error: { message: 'Original request queue is full' } });
  await expect(client.reject(41, 'Unsupported request')).rejects.toThrow('Original request queue is full');
}

/**
 * Verify that filesystem requests carry native scope metadata with the original payload.
 *
 * Args:
 *     None.
 * Returns:
 *     Promise<void>: The bridge receives the original method and its selected directory.
 */
async function verifyDirectoryEnvelope(): Promise<void> {
  await client.request('fs/readFile', { path: '/workspace/input.txt' }, '/workspace');
  const envelope = JSON.parse(nativeHost.request.mock.calls[0][0].json);
  expect(envelope).toMatchObject({
    method: 'fs/readFile', params: { path: '/workspace/input.txt' }, mobileWorkspaceRoot: '/workspace',
  });
}

it('cancels startup when the interface detaches', verifyDetachedStartup);
it('owns one polling loop across reattachment', verifyPollingOwnership);
it('reports native rejection failures', verifyRejectionFailure);
it('retains the original filesystem payload within its native envelope', verifyDirectoryEnvelope);

/**
 * Verify rejection of a runtime that lacks the interface's native contract.
 *
 * Args:
 *     None.
 * Returns:
 *     Promise<void>: An incompatible native package remains unavailable for submission.
 */
async function verifyNativeVersion(): Promise<void> {
  nativeHost.start.mockResolvedValue({ result: { workspace: '/workspace', shellAvailable: true } });
  await expect(client.start(vi.fn())).rejects.toThrow('原生内核版本不匹配');
  expect(nativeHost.poll).not.toHaveBeenCalled();
}

it('rejects an incompatible packaged native runtime', verifyNativeVersion);
