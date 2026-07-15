import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ErrorFixMemoryManager, ErrorFixRecord } from '../learning-manager';

describe('ErrorFixMemoryManager', () => {
  it('correctly calculates Jaccard and error code similarity scores', async () => {
    const records: ErrorFixRecord[] = [
      {
        id: 'fix_1',
        timestamp: Date.now(),
        category: 'compile',
        error: 'src/pages/Home.tsx(155,12): error TS2322: Type error on transition property',
        files: ['src/pages/Home.tsx'],
        diff: '+ ease: [0.6, 0.05, -0.01, 0.9] as const'
      },
      {
        id: 'fix_2',
        timestamp: Date.now(),
        category: 'compile',
        error: 'src/pages/Contact.tsx(2,43): error TS6133: AnimatePresence declared but never read',
        files: ['src/pages/Contact.tsx'],
        diff: '- import { AnimatePresence } from "framer-motion"'
      }
    ];

    const manager = ErrorFixMemoryManager as any;
    const matches = manager.findMatchingFixes('error TS2322: Transition type mismatches found', records);
    
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('fix_1');
  });

  it('generates standard unified diff strings from backups', () => {
    const tempDir = os.tmpdir();
    const rand = Math.random().toString(36).substring(7);
    const testFile = path.join(tempDir, `test_file_${rand}.txt`);

    const originalContent = 'line 1\nline 2\nline 3';
    const modifiedContent = 'line 1\nline 2 changed\nline 3';

    fs.writeFileSync(testFile, modifiedContent, 'utf8');

    try {
      const fileBackups = {
        [testFile]: originalContent
      };

      const diffStr = ErrorFixMemoryManager.generateDiffString(fileBackups, tempDir);
      
      expect(diffStr).toContain('--- a/');
      expect(diffStr).toContain('+++ b/');
      expect(diffStr).toContain('- line 2');
      expect(diffStr).toContain('+ line 2 changed');
    } finally {
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
    }
  });
});
