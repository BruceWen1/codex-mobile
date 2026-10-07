// -*- coding: utf-8 -*-
/**
 * mobile.spec.ts
 * Mobile Interface Integration Verification
 * =====================
 * Verifies responsive task input, session navigation, and both original login choices.
 */
import { expect, test } from '@playwright/test';

// Validate the actual mobile layout across common portrait viewport sizes.
for (const viewport of [{ width: 393, height: 852 }, { width: 360, height: 640 }, { width: 412, height: 915 }]) {
  test(`mobile layout ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '今天想做什么？' })).toBeVisible();
    await expect(page.getByText('界面预览', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送任务' })).toBeDisabled();
    await page.getByRole('button', { name: '整理文件' }).click();
    await expect(page.getByRole('textbox', { name: '输入任务' })).toHaveValue(/按文件类型整理/);
    await expect(page.getByRole('button', { name: '发送任务' })).toBeEnabled();
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(horizontalOverflow).toBe(false);
    await page.getByRole('button', { name: '发送任务' }).click();
    await expect(page.getByRole('status')).toContainText('系统操作需要安装');
  });
}

test('session drawer and both original login surfaces', async ({ page }) => {
  await page.goto('/');
  await page.screenshot({ path: 'artifacts/ui/mobile-home.png', animations: 'disabled' });
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await expect(page.getByText('你的任务会保存在这里')).toBeVisible();
  await page.screenshot({ path: 'artifacts/ui/mobile-sessions.png', animations: 'disabled' });
  await page.getByRole('button', { name: '关闭会话列表' }).click();
  await page.getByRole('button', { name: '登录 Codex', exact: true }).click();
  await expect(page.getByRole('button', { name: '使用 ChatGPT 登录' })).toBeVisible();
  await expect(page.getByRole('button', { name: '使用 API Key 登录' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/ui/mobile-login.png', animations: 'disabled' });
});
