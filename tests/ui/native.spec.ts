// -*- coding: utf-8 -*-
/**
 * native.spec.ts
 * Native Bridge Conversation Regression Verification
 * =====================
 * Exercises real interface state transitions through an isolated Capacitor host fixture.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { RpcEvent } from '../../src/codex';

/**
 * Install an isolated native bridge before the interface loads.
 *
 * Args:
 *     page (Page): Browser page receiving the bridge fixture.
 *     scenario (string): Failure or delayed-response scenario for this test.
 * Returns:
 *     Promise<void>: The interface is attached to the isolated original-protocol fixture.
 */
async function startNativePage(page: Page, scenario: string): Promise<void> {
  /**
   * Initialize the isolated browser-native host.
   *
   * Args:
   *     scenario (string): Original-protocol failure or delay scenario.
   * Returns:
   *     void: Native bridge methods are available before application initialization.
   */
  await page.addInitScript(function installNativeFixture(scenario: string) {
    const win = window as any;
    const fixture = win.mobileFixture = { requests: [] as any[], events: [] as any[], loggedIn: true, turnCount: 0, release: false };
    /**
     * Await release of an isolated native response.
     *
     * Args:
     *     None.
     * Returns:
     *     Promise<void>: The controlled response can complete.
     */
    async function waitForRelease(): Promise<void> {
      // Hold the original response until the scenario releases native dispatch.
      while (!fixture.release) {
        /**
         * Schedule the next isolated response check.
         *
         * Args:
         *     resolve (Function): Completion callback for the controlled delay.
         * Returns:
         *     void: The next fixture check is scheduled.
         */
        await new Promise<void>(function scheduleCheck(resolve) { setTimeout(resolve, 20); });
      }
    }
    win.CapacitorCustomPlatform = { name: 'android' };
    win.Capacitor = {
      PluginHeaders: [{ name: 'CodexRuntime', methods: [
        { name: 'start', rtype: 'promise' }, { name: 'request', rtype: 'promise' },
        { name: 'poll', rtype: 'promise' }, { name: 'selectDirectory', rtype: 'promise' }, { name: 'openUrl', rtype: 'promise' },
      ] }],
      /**
       * Dispatch a bridge call using isolated account, conversation, and event data.
       *
       * Args:
       *     plugin (string): Native plugin identifier.
       *     method (string): Native bridge method.
       *     options (object): Original bridge request payload.
       * Returns:
       *     Promise<object>: Isolated native response for the requested scenario.
       */
      nativePromise: async function dispatchNativeFixture(plugin: string, method: string, options: any) {
        // Serve startup and event polling without device access or network calls.
        if (method === 'start') return { result: { workspace: '/workspace', shellAvailable: true, bridgeApiVersion: 2, activeThreadId: scenario === 'background' ? 'saved' : null } };
        if (method === 'poll') return { events: fixture.events.splice(0, 128) };
        if (method === 'openUrl') return {};
        const request = JSON.parse(options.json);
        fixture.requests.push(request);
        // Accept responses to the original server-request identifiers.
        if (!request.method) {
          // Hold an approved original file request while its cancellation is delivered.
          if (request.mobileFileDecision === true && scenario === 'approval') await waitForRelease();
          return { result: null };
        }
        // Serve each original method consumed by the actual mobile interface.
        switch (request.method) {
          case 'account/read': return { result: { account: fixture.loggedIn ? { type: 'apiKey' } : null } };
          case 'account/logout': fixture.loggedIn = false; return { result: {} };
          case 'model/list': return { result: { data: [
            { id: 'default', model: 'fixture-default', displayName: 'Fixture Default', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
            { id: 'saved', model: 'fixture-saved', displayName: 'Fixture Saved', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
          ] } };
          case 'thread/list': return { result: { data: [{ id: 'saved', name: 'Saved session' }] } };
          case 'thread/resume': return { result: {
            model: 'fixture-saved', reasoningEffort: 'high',
            thread: { id: 'saved', cwd: '/workspace/saved', turns: [{ id: 'old', status: 'completed', items: [{ id: 'old-answer', type: 'agentMessage', text: 'Saved response' }] }] },
          } };
          case 'thread/start': return { result: { thread: { id: 'new' } } };
          case 'turn/start': {
            fixture.turnCount++;
            // Reproduce a rejected first submission before the engine creates an item.
            if (scenario === 'submission' && fixture.turnCount === 1) return { error: { message: 'Fixture submission failed' } };
            // Keep the native turn identifier unavailable until the test releases its response.
            if (scenario === 'interrupt') await waitForRelease();
            return { result: { turn: { id: 'turn-1' } } };
          }
          case 'turn/interrupt':
            fixture.events.push({ method: 'turn/completed', params: { threadId: request.params.threadId, turn: { id: 'turn-1', status: 'interrupted' } } });
            return { result: {} };
          default: throw new Error(`Unsupported fixture method: ${request.method}`);
        }
      },
    };
  }, scenario);
  await page.goto('/');
  await expect(page.getByText('本机运行', { exact: true })).toBeVisible();
  await expect(page.locator('.model-chip')).toContainText(scenario === 'background' ? 'Fixture Saved' : 'Fixture Default');
}

/**
 * Read original requests recorded by the isolated native bridge.
 *
 * Args:
 *     page (Page): Browser page owning the fixture.
 * Returns:
 *     Promise<object[]>: Original request and response envelopes recorded so far.
 */
async function requests(page: Page): Promise<Record<string, any>[]> {
  /**
   * Read original envelopes from the browser-owned fixture.
   *
   * Args:
   *     None.
   * Returns:
   *     object[]: Recorded original request and response envelopes.
   */
  return page.evaluate(function readNativeRequests() { return (window as any).mobileFixture.requests; });
}

/**
 * Append original notifications or server requests to the native event fixture.
 *
 * Args:
 *     page (Page): Browser page owning the fixture.
 *     events (RpcEvent[]): Original app-server events to deliver.
 * Returns:
 *     Promise<void>: The next native poll delivers the supplied events.
 */
async function enqueue(page: Page, events: RpcEvent[]): Promise<void> {
  /**
   * Enqueue original events in the browser-owned fixture.
   *
   * Args:
   *     events (RpcEvent[]): Original notifications and server requests.
   * Returns:
   *     void: The next native poll can deliver these events.
   */
  await page.evaluate(function enqueueNativeEvents(events) { (window as any).mobileFixture.events.push(...events); }, events);
}

/**
 * Release a delayed original-protocol response in the native fixture.
 *
 * Args:
 *     page (Page): Browser page owning the fixture.
 * Returns:
 *     Promise<void>: The held turn or file operation can complete.
 */
async function release(page: Page): Promise<void> {
  /**
   * Release the browser-owned native response delay.
   *
   * Args:
   *     None.
   * Returns:
   *     void: The pending original response can complete.
   */
  await page.evaluate(function releaseNativeResponse() { (window as any).mobileFixture.release = true; });
}

/**
 * Verify removal of a rejected optimistic message before a successful retry.
 *
 * Args:
 *     page (Page): Isolated native interface page.
 * Returns:
 *     Promise<void>: Retrying the task produces one visible user message.
 */
async function verifySubmission({ page }: { page: Page }): Promise<void> {
  await startNativePage(page, 'submission');
  await page.getByRole('textbox', { name: '输入任务' }).fill('Fixture task');
  await page.getByRole('button', { name: '发送任务' }).click();
  await expect(page.getByRole('status')).toContainText('Fixture submission failed');
  await expect(page.locator('.message.user')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '输入任务' })).toHaveValue('Fixture task');
  await page.getByRole('button', { name: '发送任务' }).click();
  await expect(page.locator('.message.user')).toHaveCount(1);
}

/**
 * Verify saved model restoration and clearing of the catalog after logout.
 *
 * Args:
 *     page (Page): Isolated native interface page.
 * Returns:
 *     Promise<void>: Resumed turns retain saved settings and logout clears model choices.
 */
async function verifyResume({ page }: { page: Page }): Promise<void> {
  await startNativePage(page, 'resume');
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await page.getByRole('button', { name: 'Saved session' }).click();
  await expect(page.locator('.model-chip')).toContainText('Fixture Saved');
  await page.getByRole('textbox', { name: '输入任务' }).fill('Continue fixture');
  await page.getByRole('button', { name: '发送任务' }).click();
  await expect(page.getByRole('button', { name: '停止任务' })).toBeVisible();
  const recorded = await requests(page);
  expect(recorded.find((request) => request.method === 'turn/start')?.params).toMatchObject({ threadId: 'saved', model: 'fixture-saved', effort: 'high' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('button', { name: '使用 ChatGPT 登录' })).toBeVisible();
  await expect(page.locator('.model-chip')).toContainText('默认模型');
}

/**
 * Verify approval ownership when a cancellation arrives during an actual dispatch.
 *
 * Args:
 *     page (Page): Isolated native interface page.
 * Returns:
 *     Promise<void>: One operation executes and the next pending request remains visible.
 */
async function verifyApprovals({ page }: { page: Page }): Promise<void> {
  await startNativePage(page, 'approval');
  await page.getByRole('textbox', { name: '输入任务' }).fill('Fixture approvals');
  await page.getByRole('button', { name: '发送任务' }).click();
  await enqueue(page, [
    { id: 41, method: 'item/tool/call', params: { threadId: 'new', tool: 'mobile_files', arguments: { operation: 'write', path: 'first.txt', content: 'first' } } },
    { id: 42, method: 'item/tool/call', params: { threadId: 'new', tool: 'mobile_files', arguments: { operation: 'write', path: 'second.txt', content: 'second' } } },
  ]);
  const allow = page.getByRole('button', { name: '允许此次操作' });
  await expect(page.locator('.approval-detail')).toContainText('first.txt');
  // Exercise repeated input before the first native operation has completed.
  /**
   * Dispatch repeated approval input to the actual interface control.
   *
   * Args:
   *     button (HTMLElement): Original approval control rendered by the interface.
   * Returns:
   *     void: Two immediate approval interactions have been dispatched.
   */
  await allow.evaluate(function repeatApproval(button) { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(allow).toBeDisabled();
  await enqueue(page, [{ method: 'serverRequest/resolved', params: { requestId: 41 } }]);
  await expect(page.locator('.approval-detail')).toContainText('second.txt');
  await release(page);
  await expect(allow).toBeEnabled();
  await expect(page.locator('.approval-detail')).toContainText('second.txt');
  const recorded = await requests(page);
  expect(recorded.filter((request) => request.mobileFileDecision === true)).toEqual([{ id: 41, mobileFileDecision: true }]);
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.locator('.approval-detail')).toHaveCount(0);
}

/**
 * Verify interruption requested while the original turn response is still pending.
 *
 * Args:
 *     page (Page): Isolated native interface page.
 * Returns:
 *     Promise<void>: The interruption uses the actual turn identifier once available.
 */
async function verifyInterruption({ page }: { page: Page }): Promise<void> {
  await startNativePage(page, 'interrupt');
  await page.getByRole('textbox', { name: '输入任务' }).fill('Delayed fixture turn');
  await page.getByRole('button', { name: '发送任务' }).click();
  await page.getByRole('button', { name: '停止任务' }).click();
  await release(page);
  await expect(page.getByRole('button', { name: '发送任务' })).toBeVisible();
  const recorded = await requests(page);
  expect(recorded.find((request) => request.method === 'turn/interrupt')?.params).toEqual({ threadId: 'new', turnId: 'turn-1' });
}

/**
 * Verify a terminal failure that has no separate original error notification.
 *
 * Args:
 *     page (Page): Isolated native interface page.
 * Returns:
 *     Promise<void>: The engine's terminal failure is visible and execution has stopped.
 */
async function verifyTerminalFailure({ page }: { page: Page }): Promise<void> {
  await startNativePage(page, 'terminal');
  await page.getByRole('textbox', { name: '输入任务' }).fill('Terminal fixture');
  await page.getByRole('button', { name: '发送任务' }).click();
  await enqueue(page, [{ method: 'turn/completed', params: { threadId: 'new', turn: { id: 'turn-1', status: 'failed', error: { message: 'Fixture terminal failure' } } } }]);
  await expect(page.getByRole('status')).toContainText('Fixture terminal failure');
  await expect(page.getByRole('button', { name: '发送任务' })).toBeVisible();
}

test('rejected submission retains one message after retry', verifySubmission);
test('resume restores engine settings and logout clears the catalog', verifyResume);
test('approval cancellation retains the next request and executes once', verifyApprovals);
test('stop during turn startup uses the original turn identifier', verifyInterruption);
test('terminal turn failures surface without a separate error event', verifyTerminalFailure);

/**
 * Verify automatic rejoin after Android recreates an interface with native task ownership.
 *
 * Args:
 *     page (Page): Isolated native interface page.
 * Returns:
 *     Promise<void>: The original task's history and settings are restored.
 */
async function verifyNativeRejoin({ page }: { page: Page }): Promise<void> {
  await startNativePage(page, 'background');
  await expect(page.getByText('Saved response', { exact: true })).toBeVisible();
  const recorded = await requests(page);
  expect(recorded.some((request) => request.method === 'thread/resume' && request.params.threadId === 'saved')).toBe(true);
}

test('native task ownership restores the interface after activity recreation', verifyNativeRejoin);

/**
 * Verify approval recovery when a cancellation was discarded during interface suspension.
 *
 * Args:
 *     page (Page): Isolated native interface page.
 * Returns:
 *     Promise<void>: The interface retains only actually pending original request identifiers.
 */
async function verifyPendingSnapshot({ page }: { page: Page }): Promise<void> {
  await startNativePage(page, 'snapshot');
  await enqueue(page, [
    { id: 41, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'old', question: 'Old fixture question' }] } },
    { id: 42, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'new', question: 'Current fixture question' }] } },
  ]);
  await expect(page.getByText('Old fixture question', { exact: true })).toBeVisible();
  await enqueue(page, [{ method: 'mobile/pendingRequests', params: { requestIds: [42] } }]);
  await expect(page.getByText('Current fixture question', { exact: true })).toBeVisible();
  await expect(page.getByText('Old fixture question', { exact: true })).toHaveCount(0);
}

test('native pending snapshots reconcile approvals after suspension', verifyPendingSnapshot);
