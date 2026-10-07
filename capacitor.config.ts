// -*- coding: utf-8 -*-
/**
 * capacitor.config.ts
 * Native Mobile Container Configuration
 * =====================
 * Packages the interface for Android and iOS with native system operations.
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.codex.mobile',
  appName: 'Codex',
  webDir: 'dist',
  android: { backgroundColor: '#f9f9f7' },
  ios: { backgroundColor: '#f9f9f7', contentInset: 'never' },
};

export default config;
