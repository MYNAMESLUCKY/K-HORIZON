import { describe, expect, it } from 'vitest';
import { inspectPlannedCommand, parseCommandFailure } from '../npm-error-parser';

describe('NpmErrorParser', () => {
  it('correctly categorizes missing local relative imports as compile errors', () => {
    const errorOutput = `
src/App.tsx(3,24): error TS2307: Cannot find module './components/molecules/Navigation' or its corresponding type declarations.
`;
    const report = parseCommandFailure(errorOutput, '', 1, null, __dirname);

    expect(report.failed).toBe(true);
    expect(report.category).toBe('compile');
    expect(report.remediation).toContain('local file/module "./components/molecules/Navigation" was not found');
  });

  it('correctly categorizes missing third-party packages as missing-dependency errors', () => {
    const errorOutput = `
Error: Cannot find module 'lodash'
`;
    const report = parseCommandFailure(errorOutput, '', 1, null, __dirname);

    expect(report.failed).toBe(true);
    expect(report.category).toBe('missing-dependency');
    expect(report.remediation).toContain('package/module "lodash" is missing. Run "npm install lodash"');
  });

  it('handles scoped packages correctly as missing-dependency errors', () => {
    const errorOutput = `
Error: Cannot find module '@types/node'
`;
    const report = parseCommandFailure(errorOutput, '', 1, null, __dirname);

    expect(report.failed).toBe(true);
    expect(report.category).toBe('missing-dependency');
    expect(report.remediation).toContain('package/module "@types/node" is missing. Run "npm install @types/node"');
  });

  it('extracts base package name for sub-path imports', () => {
    const errorOutput = `
Error: Cannot find module 'lodash/map'
`;
    const report = parseCommandFailure(errorOutput, '', 1, null, __dirname);

    expect(report.failed).toBe(true);
    expect(report.category).toBe('missing-dependency');
    expect(report.remediation).toContain('package/module "lodash/map" is missing. Run "npm install lodash"');
  });

  it('classifies signal-terminated commands as timeouts', () => {
    const report = parseCommandFailure('', 'Process killed after timeout', null, 'SIGTERM', __dirname);

    expect(report.failed).toBe(true);
    expect(report.category).toBe('timeout');
  });

  it('classifies shell missing executable messages as command-not-found', () => {
    const report = parseCommandFailure('', "'vite' is not recognized as an internal or external command", 1, null, __dirname);

    expect(report.failed).toBe(true);
    expect(report.category).toBe('command-not-found');
    expect(report.remediation).toContain('executable is not on PATH');
  });

  it('allows plain npm run because it lists available scripts', () => {
    expect(inspectPlannedCommand('npm run', __dirname)).toEqual({ ok: true });
  });
});
