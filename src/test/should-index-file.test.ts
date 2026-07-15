import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { shouldIndexFile } from '../extension';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('shouldIndexFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'should-index-file-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
  });

  it('allows indexing for normal text files', () => {
    const filePath = path.join(tempDir, 'test.ts');
    fs.writeFileSync(filePath, 'const a = 1;', 'utf8');
    expect(shouldIndexFile(filePath)).toBe(true);
  });

  it('rejects binary extensions', () => {
    const filePath = path.join(tempDir, 'image.png');
    fs.writeFileSync(filePath, 'fake binary content', 'utf8');
    expect(shouldIndexFile(filePath)).toBe(false);
  });

  it('rejects common lockfiles', () => {
    const filePath = path.join(tempDir, 'package-lock.json');
    fs.writeFileSync(filePath, '{}', 'utf8');
    expect(shouldIndexFile(filePath)).toBe(false);
  });

  it('rejects files larger than 1MB', () => {
    const filePath = path.join(tempDir, 'large.txt');
    // Create a 1.1MB file
    const data = Buffer.alloc(1.1 * 1024 * 1024);
    fs.writeFileSync(filePath, data);
    expect(shouldIndexFile(filePath)).toBe(false);
  });
});
