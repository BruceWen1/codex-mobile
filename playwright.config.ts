// -*- coding: utf-8 -*-
/**
 * playwright.config.ts
 * Mobile Interface Verification Configuration
 * =====================
 * Tests the local application in isolated headless browser instances.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  use: { baseURL: 'http://127.0.0.1:5173', channel: 'chrome', viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true },
  reporter: 'list',
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
});
