// -*- coding: utf-8 -*-
/**
 * files.test.ts
 * Native Directory Boundary Verification
 * =====================
 * Verifies that device file requests preserve the authorized directory boundary.
 */
import { describe, expect, it } from 'vitest';

import { resolveMobilePath } from '../src/files';

// Agent-generated file paths must stay inside the system-granted directory.
describe('authorized mobile paths', () => {
  it('resolves nested relative paths inside a granted root', () => {
    expect(resolveMobilePath('/workspace/documents', './reports/report.csv')).toBe('/workspace/documents/reports/report.csv');
    expect(resolveMobilePath('/workspace/documents', '')).toBe('/workspace/documents');
  });

  it.each(['../auth.json', 'reports/../../auth.json', '/etc/passwd', 'C:\\secret', 'folder\\..\\secret', 'data\0.csv'])('rejects an escaping or invalid path: %s', (path) => {
    expect(() => resolveMobilePath('/workspace/documents', path)).toThrow();
  });
});
