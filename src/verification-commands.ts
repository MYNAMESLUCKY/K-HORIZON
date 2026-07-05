import * as fs from 'fs';
import * as path from 'path';

export interface VerificationCommands {
  compileCommand: string;
  testCommand: string | null;
}

export function detectVerificationCommands(workspaceRoot: string): VerificationCommands {
  const packageJsonPath = path.join(workspaceRoot, 'package.json');
  let compileCommand = fs.existsSync(path.join(workspaceRoot, 'tsconfig.json')) ? 'npx tsc --noEmit' : 'npm run compile';
  let testCommand: string | null = null;

  try {
    if (!fs.existsSync(packageJsonPath)) {
      return { compileCommand, testCommand };
    }

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const scripts = pkg.scripts || {};

    if (scripts.compile) {
      compileCommand = 'npm run compile';
    } else if (scripts.build) {
      compileCommand = 'npm run build';
    } else if (scripts.typecheck) {
      compileCommand = 'npm run typecheck';
    } else if (fs.existsSync(path.join(workspaceRoot, 'tsconfig.json'))) {
      compileCommand = 'npx tsc --noEmit';
    }

    if (scripts.test && !/no test specified|exit 1/i.test(String(scripts.test))) {
      testCommand = 'npm run test';
    } else if (scripts.vitest) {
      testCommand = 'npm run vitest';
    } else if (scripts.jest) {
      testCommand = 'npm run jest';
    }
  } catch (err) {
    console.error('Failed to detect verification commands:', err);
  }

  return { compileCommand, testCommand };
}
