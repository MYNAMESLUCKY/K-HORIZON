import * as fs from 'fs';
import * as path from 'path';

/**
 * Structured representation of a parsed npm / shell command failure.
 *
 * The agent's self-heal loop historically relied on substring matching
 * ("fail" / "error") inside the raw child_process output. That is both
 * imprecise (false positives on `npm WARN deprecated`, `0 errors`, etc.)
 * and lossy (it discards the structured `npm ERR! code X` fields npm itself
 * prints). This module pulls out the parts an LLM actually needs to fix the
 * failure: the exit code, the npm error code, the offending file path, the
 * human-readable summary, and a curated view of the relevant lines.
 */
export interface NpmErrorReport {
  /** True when the output looks like a real failure (exit != 0 OR structured npm ERR! lines). */
  failed: boolean;

  /** Raw exit code from the child process (null if killed by signal). */
  exitCode: number | null;

  /** Signal that killed the process (e.g. 'SIGTERM'). null if it exited normally. */
  signal: string | null;

  /** True when the output contains `npm ERR!` lines. */
  isNpmOutput: boolean;

  /** Parsed `npm ERR! code X` value (e.g. ELIFECYCLE, EACCES, ENOENT, ERESOLVE). */
  npmErrorCode: string | null;

  /** Parsed `npm ERR! errno N` value (numeric errno). */
  npmErrno: number | null;

  /** Parsed `npm ERR! path <p>` value. */
  npmPath: string | null;

  /** First human-readable `npm ERR! <message>` line that is NOT `code`, `errno`, or `path`. */
  npmMessage: string | null;

  /** All non-noise `npm ERR!` lines, in order. */
  npmErrorLines: string[];

  /** Heuristic guess of the offending source file inside the workspace, if any. */
  suspectedFile: string | null;

  /** Path to npm's debug log if npm printed one (npm prints it on failure). */
  debugLogPath: string | null;

  /** Curated, head-anchored excerpt that preserves the diagnostic middle of the log. */
  curatedExcerpt: string;

  /** Heuristic classification of the failure category for LLM guidance. */
  category: NpmErrorCategory;

  /** Suggested remediation hint derived from the parsed error code. */
  remediation: string | null;
}

export type NpmErrorCategory =
  | 'missing-dependency'
  | 'missing-script'
  | 'missing-package-json'
  | 'enoent'
  | 'eacces'
  | 'eresolve'
  | 'epeer'
  | 'elifecycle'
  | 'compile'
  | 'test-failure'
  | 'timeout'
  | 'command-not-found'
  | 'unknown'
  | 'success';

/**
 * Try to extract a path token from an arbitrary error line.
 * Matches both POSIX and Windows-style relative or absolute paths that look like
 * source files (ts/js/json), and returns the first reasonable candidate.
 */
function extractFilePath(line: string): string | null {
  // POSIX absolute: /foo/bar/baz.ts
  const posix = line.match(/(\/[\w.\-/]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|scss|css|html|vue|svelte|py|rs|go|java|cpp|c|h|cs|rb|php|swift|kt))/i);
  if (posix) return posix[1];
  // Windows absolute: C:\foo\bar\baz.ts
  const win = line.match(/([A-Za-z]:[\\\/][\w.\\\- ]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|scss|css|html|vue|svelte|py|rs|go|java|cpp|c|h|cs|rb|php|swift|kt))/i);
  if (win) return win[1];
  // Workspace-relative: src/foo/bar.ts
  const rel = line.match(/\b((?:src|lib|app|test|tests|spec|specs|dist|out|build|public|packages|apps)\/[\w.\-/]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|java|cpp|c|h|cs|rb|php|rs|go|swift|kt))/i);
  if (rel) return rel[1];
  return null;
}

/**
 * Build a curated excerpt that anchors on the diagnostic middle of the log
 * (where `npm ERR!` lines live) instead of the head/tail-only truncation the
 * agent used before. We keep:
 *   - First ~1500 chars (npm notice banner / install summary header)
 *   - All `npm ERR!` lines plus their 2 lines of context (this is the
 *     diagnostic middle the previous code was throwing away)
 *   - Last ~1500 chars (timing summary / final stack frame)
 */
function buildCuratedExcerpt(stdout: string, stderr: string, errorLines: string[]): string {
  const MAX_HEAD = 1500;
  const MAX_TAIL = 1500;
  const MAX_MIDDLE = 6000;

  const combined = (stdout || '') + (stderr || '');
  if (!combined) return '';

  // Quick path: short output, no curation needed
  if (combined.length <= MAX_HEAD + MAX_TAIL + MAX_MIDDLE) {
    return combined.trim();
  }

  const head = combined.slice(0, MAX_HEAD);
  const tail = combined.slice(combined.length - MAX_TAIL);

  if (errorLines.length === 0) {
    return (head + `\n\n... [TRUNCATED ${combined.length - MAX_HEAD - MAX_TAIL} CHARACTERS] ...\n\n` + tail).trim();
  }

  // Find each error line's index in the combined text so we can pull surrounding context
  const middleBlocks: string[] = [];
  let consumed = 0;
  const seenRanges: Array<[number, number]> = [];

  for (const errLine of errorLines) {
    const idx = combined.indexOf(errLine, consumed);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 200);
    const end = Math.min(combined.length, idx + errLine.length + 200);
    // De-dupe overlapping windows
    const overlaps = seenRanges.some(([s, e]) => !(end < s || start > e));
    if (overlaps) continue;
    seenRanges.push([start, end]);
    middleBlocks.push(combined.slice(start, end));
    consumed = end;
    if (middleBlocks.join('\n').length > MAX_MIDDLE) break;
  }

  const middle = middleBlocks.length > 0
    ? middleBlocks.join('\n... [DIAGNOSTIC MIDDLE ELIDED] ...\n')
    : combined.slice(Math.floor(combined.length / 2) - MAX_MIDDLE / 2, Math.floor(combined.length / 2) + MAX_MIDDLE / 2);

  return (
    head +
    `\n\n... [HEAD ${MAX_HEAD} CHARS] ...\n\n` +
    middle +
    `\n\n... [TAIL ${MAX_TAIL} CHARS] ...\n\n` +
    tail
  ).trim();
}

/**
 * Map a parsed `npm ERR! code` to a coarse category and remediation hint.
 * The hint is short, action-oriented, and intended for inclusion in the
 * fix-prompt the LLM sees — it nudges the model toward known-good responses
 * (e.g. install missing deps, run with --legacy-peer-deps, chmod permissions).
 */
function getBasePackage(pkgName: string, workspaceRoot?: string): string | null {
  if (pkgName.startsWith('.') || pkgName.startsWith('/') || pkgName.startsWith('\\') || /^[A-Za-z]:[\\\/]/.test(pkgName)) {
    return null; // Local file
  }
  
  if (workspaceRoot) {
    const firstPart = pkgName.split('/')[0];
    try {
      if (fs.existsSync(path.join(workspaceRoot, firstPart)) || fs.existsSync(path.join(workspaceRoot, 'src', firstPart))) {
        return null;
      }
    } catch {
      // Safe fallback if filesystem access fails
    }
  }

  if (pkgName.startsWith('@')) {
    const parts = pkgName.split('/');
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return pkgName;
  }
  const parts = pkgName.split('/');
  return parts[0];
}

function categorize(
  npmErrorCode: string | null,
  message: string | null,
  combinedOutput = '',
  workspaceRoot?: string
): { category: NpmErrorCategory; remediation: string | null } {
  const code = (npmErrorCode || '').toUpperCase();
  const msg = (message || '').toLowerCase();
  const combinedLower = combinedOutput.toLowerCase();

  const isCompile = /tsc\b|typescript|cannot find name|cannot find module|\bts\d+\b|\[tsl\]|type error|error TS\d+|compilation failed|error: cannot find symbol|error: \w+ expected|gcc|g\+\+|clang|make: \*\*\*|error\[E\d+\]:|undefined: |imported and not used|syntax error|parse error|fatal error/i.test(combinedLower);
  const isTest = /vitest\b|jest|test\b|spec\b|fail|assert|\bexpect\b|pytest\b|unittest\b|junit\b|assertionerror|panicked at/i.test(combinedLower) && !isCompile;

  if (code === 'ENOSCRIPT' || /missing script|missing script:/i.test(msg) || /missing script/i.test(combinedLower)) {
    return {
      category: 'missing-script',
      remediation: 'The package.json does not define the requested npm script. Either add the script to package.json scripts, or change the verification command to one that exists. Use `npm run` (no args) to list available scripts.',
    };
  }
  if (code === 'ENOENT' && /package\.json/i.test(msg)) {
    return {
      category: 'missing-package-json',
      remediation: 'No package.json was found in the working directory. cd into the directory that contains package.json, or update the verification command to point at a subdirectory with package.json.',
    };
  }
  if (code === 'ENOENT' || /enoent|no such file/i.test(msg)) {
    return {
      category: 'enoent',
      remediation: 'A referenced file or directory does not exist. Verify the path in the failing tool call (especially directory arguments) matches a real file in the workspace.',
    };
  }
  if (code === 'EACCES' || /eacces|permission denied/i.test(msg)) {
    return {
      category: 'eacces',
      remediation: 'The command lacks permission to read/write a file. Do not retry with sudo. Either change the file permissions, move the operation to a writable directory, or skip the operation.',
    };
  }
  if (code === 'ERESOLVE' || /eresolve|could not resolve dependency|peer dep/i.test(msg)) {
    return {
      category: 'eresolve',
      remediation: 'npm could not resolve the dependency graph (likely a peer-dependency conflict). Try installing with `--legacy-peer-deps` or `--force`, or pin a compatible version in package.json. Do not invent unrelated code edits.',
    };
  }
  if (code === 'EPEERDEP' || /peer dep/i.test(msg)) {
    return {
      category: 'epeer',
      remediation: 'A peer-dependency conflict was detected. Either install the missing peer, downgrade the conflicting package, or add `--legacy-peer-deps` to the install command.',
    };
  }
  if (code === 'ELIFECYCLE' || /elifecycle/i.test(msg)) {
    return {
      category: 'elifecycle',
      remediation: 'A npm script exited with a non-zero status. Read the underlying error message above the ELIFECYCLE line for the actual root cause (compile error, missing dep, test failure, etc.) and fix that, not the script itself.',
    };
  }
  if (/cannot find module ['"]([^'"]+)['"]|module not found: error: can't resolve ['"]([^'"]+)['"]/i.test(combinedOutput)) {
    const match = combinedOutput.match(/cannot find module ['"]([^'"]+)['"]|module not found: error: can't resolve ['"]([^'"]+)['"]/i);
    const pkg = match ? (match[1] || match[2]) : '';
    
    const basePkg = getBasePackage(pkg, workspaceRoot);
    if (!basePkg) {
      return {
        category: 'compile',
        remediation: `The local file/module "${pkg}" was not found. Please verify that the file exists and the import path is correct relative to the current file.`,
      };
    }
    return {
      category: 'missing-dependency',
      remediation: `The package/module "${pkg}" is missing. Run "npm install ${basePkg}" to install it, or add it to package.json and run "npm install".`,
    };
  }
  if (/tsc|typescript|cannot find name|cannot find module|ts\(|type error/i.test(msg) || isCompile) {
    return {
      category: 'compile',
      remediation: 'A compile error or syntax issue was reported (TSC, GCC, Clang, Javac, Rustc, Go, etc.). Open the file at the reported line/column and address the compilation, type, or syntax error directly. Do not modify dependencies unless a missing package is the actual cause.',
    };
  }
  if (/test|spec|fail|assert|\bexpect\b/i.test(msg) || isTest) {
    return {
      category: 'test-failure',
      remediation: 'An automated test failed (Vitest, Pytest, JUnit, Cargo test, Go test, etc.). Read the assertion failure message and expected vs actual values, locate the crash traceback, and fix the underlying code, not the test expectations (unless the test was wrong).',
    };
  }
  if (/command not found|is not recognized as an internal or external command/i.test(msg) ||
      /command not found|is not recognized as an internal or external command/i.test(combinedOutput)) {
    return {
      category: 'command-not-found',
      remediation: 'The executable is not on PATH. Either install it, use the npx/yarn equivalent, or run the tool through VS Code\'s integrated terminal which has the user\'s full PATH.',
    };
  }
  return { category: 'unknown', remediation: null };
}

/**
 * Parse the combined output of a child_process invocation into a structured
 * failure report. Safe to call on any output — returns `failed: false` when
 * the command appears to have succeeded.
 *
 * @param stdout  Raw stdout captured from the child process
 * @param stderr  Raw stderr captured from the child process
 * @param exitCode  Numeric exit code, or null if killed by signal
 * @param signal  Signal name that killed the process, or null
 * @param workspaceRoot  Workspace root, used to relativize any detected file paths
 */
export function parseCommandFailure(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  signal: string | null,
  workspaceRoot: string
): NpmErrorReport {
  const combined = (stdout || '') + (stderr || '');
  const lines = combined.split(/\r?\n/);

  const npmErrorLines: string[] = [];
  let npmErrorCode: string | null = null;
  let npmErrno: number | null = null;
  let npmPath: string | null = null;
  let npmMessage: string | null = null;
  let suspectedFile: string | null = null;
  let debugLogPath: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // npm writes structured error lines as: `npm ERR! <key> <value>`
    const npmErrMatch = line.match(/^npm\s+ERR!\s+(.+)$/);
    if (npmErrMatch) {
      const body = npmErrMatch[1];
      npmErrorLines.push(line);

      // Extract well-known keys first
      const codeMatch = body.match(/^code\s+([A-Z0-9_]+)/i);
      if (codeMatch) {
        npmErrorCode = codeMatch[1].toUpperCase();
        continue;
      }
      const errnoMatch = body.match(/^errno\s+(-?\d+)/i);
      if (errnoMatch) {
        npmErrno = parseInt(errnoMatch[1], 10);
        continue;
      }
      const pathMatch = body.match(/^path\s+(.+)$/i);
      if (pathMatch) {
        npmPath = pathMatch[1].trim();
        continue;
      }
      const logfileMatch = body.match(/^logfile\s+(.+)$/i);
      if (logfileMatch) {
        debugLogPath = logfileMatch[1].trim();
        continue;
      }
      // Anything else with non-empty body is a candidate for the human message
      if (!npmMessage && body.trim().length > 0 && !/^npm\s/i.test(body)) {
        npmMessage = body.trim();
      }
      continue;
    }

    // Check for other compiler/linter/test error indicators (TS compiler, Webpack, Vitest, Jest, general Error)
    const isCompilerErrorLine = /(?:error TS\d+:|ERROR in|\[tsl\] ERROR|SyntaxError|AssertionError|Error:|FAIL| ❯ | ✗ |Traceback\s+\(|NameError:|TypeError:|ImportError:|ModuleNotFoundError:|java\.lang\.\w+Exception|Compilation failed|error: cannot find symbol|error:|warning:|fatal error:|segmentation fault|make: \*\*\*|error\[E\d+\]:|thread 'main' panicked|panic: |Parse error:|Fatal error:|undefined method)/i.test(line);
    if (isCompilerErrorLine) {
      npmErrorLines.push(line);
    }

    // npm also prints: "A complete log of this run can be found in: <path>"
    const logHint = line.match(/log of (?:this|each) run can be found in:\s*(.+)/i);
    if (logHint) {
      debugLogPath = logHint[1].trim();
      continue;
    }

    // Try to extract a suspected source file from any non-empty line
    if (!suspectedFile) {
      const candidate = extractFilePath(line);
      if (candidate) {
        suspectedFile = candidate;
      }
    }
  }

  // If we found an absolute path, try to relativize it against the workspace
  if (suspectedFile && workspaceRoot && path.isAbsolute(suspectedFile)) {
    const rel = path.relative(workspaceRoot, suspectedFile);
    if (rel && !rel.startsWith('..')) {
      suspectedFile = rel.replace(/\\/g, '/');
    }
  }

  const isNpmOutput = npmErrorLines.length > 0 || /\bnpm\s+(?:ERR|notice|WARN)\b/.test(combined);

  // Failure is determined by:
  //   1. non-zero exit code (primary signal — most reliable)
  //   2. presence of `npm ERR!` structured errors (covers the Windows
  //      case where cmd.exe returns 0 even when npm failed)
  //   3. signal termination (SIGTERM / SIGKILL etc.)
  const failed =
    (typeof exitCode === 'number' && exitCode !== 0) ||
    (signal !== null && signal !== undefined) ||
    npmErrorLines.length > 0;

  const { category, remediation } = categorize(npmErrorCode, npmMessage, combined, workspaceRoot);
  const curatedExcerpt = buildCuratedExcerpt(stdout || '', stderr || '', npmErrorLines);

  // Override category for timeout cases (signal-based termination)
  let finalCategory: NpmErrorCategory = category;
  if (signal && /SIG(KILL|TERM|INT)/.test(signal)) {
    // Child-process signal termination usually means our command timeout or
    // cancellation path killed the process. Surface that explicitly instead of
    // leaving it as an unknown failure.
    finalCategory = 'timeout';
  }

  return {
    failed,
    exitCode,
    signal,
    isNpmOutput,
    npmErrorCode,
    npmErrno,
    npmPath,
    npmMessage,
    npmErrorLines,
    suspectedFile,
    debugLogPath,
    curatedExcerpt,
    category: finalCategory,
    remediation,
  };
}

/**
 * Convenience wrapper: also classify a command-line string itself so we can
 * short-circuit before execution (e.g. when the user / LLM asks us to run a
 * script that doesn't exist in package.json).
 */
export function inspectPlannedCommand(command: string, cwd: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: 'Empty command.' };
  if (/^npm\s+(?:run|run-script)\s*$/i.test(trimmed)) {
    return { ok: true };
  }

  // Detect `npm run <script>` / `npm test` / `npm start` / `npm <lifecycle>` with no script in package.json
  const npmScriptMatch = trimmed.match(/^npm\s+(?:run(?:-script)?\s+)?([A-Za-z0-9_:.-]+)/i);
  if (npmScriptMatch && cwd) {
    const scriptName = npmScriptMatch[1].toLowerCase();
    // Built-in lifecycle scripts that always exist, including scaffolding commands
    // that DON'T require a pre-existing package.json (they create one).
    const builtins = new Set(['test', 'start', 'stop', 'restart', 'install', 'uninstall', 'publish', 'version', 'init', 'create']);
    // npm init and npm create are project-scaffolding commands — they don't need a pkg.json
    if (scriptName === 'init' || scriptName === 'create') {
      return { ok: true };
    }
    if (!builtins.has(scriptName)) {
      const pkgPath = path.join(cwd, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        return { ok: false, reason: `No package.json found in ${cwd}. Run \`npm init -y\` first to create one.` };
      }
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const scripts = (pkg && pkg.scripts) || {};
        if (!scripts[scriptName]) {
          return {
            ok: false,
            reason: `package.json in ${cwd} does not define a "${scriptName}" script. Available scripts: ${
              Object.keys(scripts).join(', ') || '(none)'
            }`,
          };
        }
      } catch {
        return { ok: false, reason: `Failed to read package.json in ${cwd}.` };
      }
    }
  }

  return { ok: true };
}
