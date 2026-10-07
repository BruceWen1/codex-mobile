// -*- coding: utf-8 -*-
/**
 * render-icon.mjs
 * Native Identity Asset Renderer
 * =====================
 * Exports the code-defined mobile identity mark for the iOS application icon.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

/**
 * Render the code-defined identity mark as a native iOS icon.
 *
 * Args:
 *     None.
 * Returns:
 *     Promise<void>: The native icon asset is exported and render timing is reported.
 */
async function main() {
  const started = performance.now();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  // Render the same geometric mark used by the mobile interface and Android vector icon.
  await page.setContent('<html><body style="margin:0;background:#252521;display:grid;place-items:center;width:1024px;height:1024px"><svg width="640" height="640" viewBox="0 0 48 48" fill="none"><path d="M17 12H10V19L5 24L10 29V36H17M31 12H38V19L43 24L38 29V36H31M27 10L21 38" stroke="#f9f9f7" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg></body></html>');
  const rendered = performance.now();
  await page.screenshot({ path: resolve(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'), animations: 'disabled' });
  await browser.close();
  process.stdout.write(JSON.stringify({ renderMs: Math.round(rendered - started), totalMs: Math.round(performance.now() - started) }) + '\n');
}

await main();
