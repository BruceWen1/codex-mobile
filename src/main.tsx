// -*- coding: utf-8 -*-
/**
 * main.tsx
 * Mobile Interface Entry Point
 * =====================
 * Mounts the mobile client and records startup timing through the Performance API.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

/**
 * Mount the application and measure interface initialization.
 *
 * Args:
 *     None.
 * Returns:
 *     void: The interface is mounted in the document root.
 */
function main(): void {
  performance.mark('app-start');
  // Mount the shared interface inside the native web container.
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
  performance.mark('app-mounted');
  performance.measure('interface-initialization', 'app-start', 'app-mounted');
  performance.measure('total-startup', 'app-start', 'app-mounted');
}

main();
