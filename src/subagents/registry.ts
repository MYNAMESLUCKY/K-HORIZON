// src/subagents/registry.ts
//
// Named subagent profiles. Each profile bundles:
//   - a system prompt (domain-specific instructions)
//   - a tool allow-list (tools the subagent may invoke)
//   - a default model (lighter or stronger depending on the task)
//   - a skill bundle (entries from src/skills/skill-catalog.ts)
//
// The agent graph (src/agent-graph.ts) uses these to dispatch the right
// subagent for a given user prompt.

import { retrieveSkills, SkillEntry } from '../skills/skill-catalog';
import { findSkillById } from '../skills/skill-catalog';
import { AIService } from '../ai-service';

export type SubagentId =
  | 'frontend-designer'
  | 'backend-architect'
  | 'mobile-builder'
  | 'security-reviewer'
  | 'test-writer'
  | 'general-builder';

export interface SubagentProfile {
  id: SubagentId;
  label: string;
  description: string;
  systemPrompt: string;
  /** Tool names this subagent is allowed to call. Empty = no restriction. */
  toolAllowList: string[];
  /** Keywords that route a user prompt to this subagent. */
  triggers: string[];
  /** Skill ids to always load (in addition to query-matched skills). */
  pinnedSkillIds: string[];
}

const COMMON_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'list_dir',
  'grep_search',
  'find_files',
  'run_command',
  'git_status',
  'git_diff',
  'web_search',
  'fetch_webpage',
  'web_scrape',
  'get_library_docs',
  'get_active_editor_context',
  'get_diagnostics',
  'get_file_outline',
  'search_workspace_symbols',
  'find_references',
  'find_definitions',
  'show_info_message',
  'get_vscode_extensions',
  'send_to_terminal',
  'open_file_to_side',
  'preview_html',
  'execute_vscode_command',
  'verify_edit',
  'switch_subagent',
  'create_webhook_token',
  'get_webhook_requests',
  'patch_file_lines',
  'insert_file_lines',
  'copy_file',
  'move_file',
  'run_speculative_patch',
  'synthesize_custom_tool',
  'capture_page_screenshot',
  'run_speculative_workspace_patch',
  'update_dependency_graph',
  'trace_symbol_dependency',
  'replace_in_files',
  'get_file_metadata',
  'create_directory',
  'git_diff_file',
  'request_hunk_reviews',
  'run_fuzz_test',
  'db_query',
  'db_status',
  'get_learning_rules',
  'add_learning_rule',
  'delete_learning_rule',
  'get_vscode_settings',
  'update_vscode_settings',
  'toggle_autocomplete',
  'sequentialthinking',
  'sequential_thinking',
  'SequentialThinking',
  'call_mcp_tool',
  'mcp__*',
];

export function isToolAllowedForSubagent(subagentId: SubagentId, toolName: string): boolean {
  const profile = SUBAGENTS.find(sub => sub.id === subagentId);
  if (!profile) return false;
  return profile.toolAllowList.some(pattern => {
    if (pattern === toolName) return true;
    if (pattern.endsWith('*')) {
      return toolName.startsWith(pattern.slice(0, -1));
    }
    return false;
  });
}

export const SUBAGENTS: SubagentProfile[] = [
  {
    id: 'frontend-designer',
    label: 'Frontend Designer',
    description: 'React/Next/CSS/Tailwind/HTML UI tasks.',
    systemPrompt:
      'You are a senior frontend designer. Produce accessible, mobile-first, ' +
      'production-quality UI. Use semantic HTML, ARIA labels, and visible focus ' +
      'states. Prefer Tailwind utility classes. Never use placeholder code. ' +
      'To fetch the latest, up-to-date documentation on frontend libraries (React, Tailwind, Next, etc.), ' +
      'always query the Context7 MCP server using its "query-docs" tool.',
    toolAllowList: COMMON_TOOLS,
    triggers: ['react', 'next', 'nextjs', 'css', 'tailwind', 'html', 'landing page',
               'ui', 'ux', 'component', 'frontend', 'hero section', 'pricing page',
               'marketing page', 'homepage', 'styling', 'responsive design',
               'website design', 'web design', 'dashboard ui', 'form design'],
    pinnedSkillIds: ['claude-frontend-design', 'claude-web-artifacts', 'stitch-react', 'openai-frontend', 'project-scaffold', 'gsap-animation', 'animejs-animation', 'shadcn-ui', 'google-fonts', 'svgrepo-icons', 'undraw-illustrations', 'daisyui-components', 'chartjs-charts'],
  },
  {
    id: 'backend-architect',
    label: 'Backend Architect',
    description: 'APIs, databases, auth, queues, serverless.',
    systemPrompt:
      'You are a principal backend engineer. Design secure, type-safe, ' +
      'observable APIs. Validate every input at the edge. Use parameterized ' +
      'queries. Never log secrets. Produce migrations and tests alongside code. ' +
      'To fetch the latest backend library, database client, or configuration documentation (Express, Postgres, Prisma, etc.), ' +
      'always query the Context7 MCP server using its "query-docs" tool.',
    toolAllowList: COMMON_TOOLS,
    triggers: ['api', 'endpoint', 'rest', 'graphql', 'crud', 'server', 'backend',
               'database', 'postgres', 'mysql', 'redis', 'queue', 'auth', 'login',
               'signup', 'webhook', 'fastify', 'express', 'lambda', 'worker'],
    pinnedSkillIds: ['vercel-next-bp', 'cloudflare-workers', 'neon-postgres',
             'better-auth', 'stripe', 'spring-boot', 'rest-api', 'graphql-api', 'nodejs-backend', 'nextjs-web', 'express-api', 'flask-api', 'django-api', 'mysql-db', 'postgres-db'],
  },
  {
    id: 'mobile-builder',
    label: 'Mobile Builder',
    description: 'React Native, Expo, iOS/Android.',
    systemPrompt:
      'You are a React Native specialist. Optimize for cold-start, frame rate, ' +
      'and bundle size. Use Expo SDK features over ejecting when possible. ' +
      'Always include offline / error states in mobile UI. ' +
      'To fetch the latest React Native or Expo documentation, ' +
      'always query the Context7 MCP server using its "query-docs" tool.',
    toolAllowList: COMMON_TOOLS,
    triggers: ['mobile', 'ios', 'android', 'react-native', 'expo', 'swift',
               'running', 'native', 'app store', 'play store', 'push notification'],
    pinnedSkillIds: ['callstack-rn', 'expo-ui', 'expo-deploy', 'better-auth'],
  },
  {
    id: 'security-reviewer',
    label: 'Security Reviewer',
    description: 'Audits, dependency review, secrets, OWASP.',
    systemPrompt:
      'You are a Trail of Bits-trained security reviewer. Find injection, ' +
      'authn/authz, secrets, SSRF, deserialization, and supply-chain issues. ' +
      'Cite file:line for every finding. Suggest minimal patches. ' +
      'To fetch package vulnerabilities, security advisories, or API specs, ' +
      'query the Context7 MCP server using its "query-docs" tool.',
    toolAllowList: COMMON_TOOLS,
    triggers: ['security', 'audit', 'vulnerability', 'cve', 'owasp', 'review',
               'penetration', 'pentest', 'threat model', 'secrets', 'xss',
               'sql injection', 'csrf', 'ssrf'],
    pinnedSkillIds: ['tob-secure', 'tob-static', 'tob-insecure'],
  },
  {
    id: 'test-writer',
    label: 'Test Writer',
    description: 'Vitest, Playwright, property-based tests.',
    systemPrompt:
      'You are a test engineer. Add vitest unit tests and Playwright e2e ' +
      'tests. Cover happy paths, edge cases, and error states. Never write ' +
      'tests that always pass — assert specific outcomes. ' +
      'To fetch the latest Vitest, Playwright, or Jest API documentation, ' +
      'always query the Context7 MCP server using its "query-docs" tool.',
    toolAllowList: COMMON_TOOLS,
    triggers: ['test', 'tests', 'spec', 'coverage', 'vitest', 'jest', 'playwright',
               'e2e', 'unit test', 'integration test', 'snapshot'],
    pinnedSkillIds: ['claude-webapp-test', 'tob-pbt', 'testing-tools'],
  },
  {
    id: 'general-builder',
    label: 'General Builder',
    description: 'Catch-all default for anything else.',
    systemPrompt:
      'You are a senior full-stack engineer. Produce complete, working, ' +
      'idiomatic code. No placeholders, no TODOs. Verify with the test/compile ' +
      'loop before declaring success. ' +
      'To fetch the latest, up-to-date documentation on any library or language feature, ' +
      'always query the Context7 MCP server using its "query-docs" tool.',
    toolAllowList: COMMON_TOOLS,
    triggers: [],
    pinnedSkillIds: ['ms-typescript', 'project-scaffold'],
  },
];

/** Route a free-form prompt to the best subagent. Falls back to general-builder. */
export async function dispatchSubagent(prompt: string): Promise<SubagentProfile> {
  const p = prompt.toLowerCase();
  
  // Calculate scores for all subagents
  const candidates: { sub: SubagentProfile; score: number }[] = [];
  for (const sub of SUBAGENTS) {
    let score = 0;
    for (const trig of sub.triggers) {
      if (p.includes(trig)) {
        // Weight longer triggers higher so "react-native" beats "react"
        score += trig.length;
      }
    }
    candidates.push({ sub, score });
  }

  // Sort candidates by score descending
  candidates.sort((a, b) => b.score - a.score);

  const highestScore = candidates[0].score;
  const runnerUpScore = candidates[1] ? candidates[1].score : 0;

  // If we have a clear, high-scoring keyword match, route immediately (fast & token-efficient)
  // Require a minimum absolute score AND a gap over runner-up to avoid routing on short generic words
  if (highestScore >= 8 && (highestScore - runnerUpScore > 4)) {
    return candidates[0].sub;
  }

  // Otherwise, use the LLM to classify the user's intent
  try {
    const classificationPrompt = `You are an AI coordinator. Your job is to classify the user's coding request into the single best specialist agent profile ID.

Available specialist profiles:
1. "frontend-designer" - Selected for React/Next/CSS/Tailwind/HTML UI tasks, landing pages, custom styling, responsive design.
2. "backend-architect" - Selected for APIs, databases, authentication, logins, stripe integrations, webhooks, or background queues.
3. "mobile-builder" - Selected for React Native, Expo, iOS/Android specific configurations, mobile screens.
4. "security-reviewer" - Selected for security audits, OWASP vulnerability checks, scanning dependencies, or static analysis.
5. "test-writer" - Selected for Vitest, Playwright, E2E/Unit testing, writing spec files.
6. "general-builder" - Selected as a default full-stack developer profile when none of the above are a clear fit.

Rules:
- Output ONLY the profile ID (e.g., "frontend-designer"). Do not explain.
- Do not output markdown, quotes, or trailing spaces.

User Coding Request:
"${prompt}"

Select the most suitable profile ID from: frontend-designer, backend-architect, mobile-builder, security-reviewer, test-writer, general-builder.`;

    const response = await AIService.streamResponse(
      [{ role: 'user', content: classificationPrompt, timestamp: Date.now() }],
      'You are a classification assistant. Output only the selected agent profile ID.',
      () => {}
    );

    const cleanResponse = response.trim().toLowerCase().replace(/['"`]/g, '');
    const matchedSubagent = SUBAGENTS.find(s => s.id === cleanResponse);
    if (matchedSubagent) {
      return matchedSubagent;
    }
  } catch (err) {
    console.error('LLM Intent Classification failed, falling back to keyword heuristics:', err);
  }

  return highestScore > 0 ? candidates[0].sub : SUBAGENTS.find(s => s.id === 'general-builder')!;
}

/** Returns pinned skills + query-matched skills, deduplicated, capped at 8. */
export function resolveSkillsForSubagent(sub: SubagentProfile, prompt: string): SkillEntry[] {
  const scored = new Map<string, { skill: SkillEntry; score: number }>();

  const addSkill = (skill: SkillEntry | undefined, score: number) => {
    if (!skill) return;
    const current = scored.get(skill.id);
    if (!current || score > current.score) {
      scored.set(skill.id, { skill, score });
    }
  };

  // Always include exact pinned skills first, if they exist in the local catalog.
  for (const id of sub.pinnedSkillIds) {
    addSkill(findSkillById(id), 100);
  }

  // Then add prompt-matched skills.
  let promptRank = 50;
  for (const skill of retrieveSkills(prompt, 8)) {
    addSkill(skill, promptRank--);
  }

  // Finally, use the subagent metadata itself to surface the right skills even
  // when the user prompt is short or ambiguous.
  const contextQuery = [sub.label, sub.description, ...sub.triggers.slice(0, 6)].join(' ');
  let contextRank = 30;
  for (const skill of retrieveSkills(contextQuery, 8)) {
    addSkill(skill, contextRank--);
  }

  return Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(entry => entry.skill);
}
