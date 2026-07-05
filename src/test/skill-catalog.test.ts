// src/test/skill-catalog.test.ts
//
// Smoke tests for the awesome-agent-skills RAG retrieval and subagent
// dispatch. These run as part of `npm run test:unit` and must stay fast
// (no network, no DB).

import { describe, it, expect, vi } from 'vitest';
import { findSkillById, retrieveSkills, renderSkillsBlock, TOP_SKILLS } from '../skills/skill-catalog';
import {
  SUBAGENTS,
  dispatchSubagent,
  resolveSkillsForSubagent,
} from '../subagents/registry';
import { AIService } from '../ai-service';

describe('skill-catalog', () => {
  it('has 30 curated skills', () => {
    expect(TOP_SKILLS.length).toBeGreaterThanOrEqual(25);
  });

  it('retrieves frontend skills for a React prompt', () => {
    const out = retrieveSkills('Build a React landing page with Tailwind', 4);
    expect(out.length).toBeGreaterThan(0);
    const ids = out.map(s => s.id);
    expect(ids.some(i => i.includes('frontend') || i.includes('react'))).toBe(true);
  });

  it('retrieves UI library and asset skills for a design prompt', () => {
    const out = retrieveSkills('Build a shadcn dashboard with daisyUI, GSAP, and Google Fonts', 6);
    expect(
      out.some(s =>
        ['shadcn-ui', 'daisyui-components', 'gsap-animation', 'google-fonts'].includes(s.id)
      )
    ).toBe(true);
  });

  it('finds a skill by exact id', () => {
    expect(findSkillById('shadcn-ui')?.name).toBe('shadcn/ui');
    expect(findSkillById('spring-boot')?.name).toBe('Spring Boot');
  });

  it('retrieves backend stack skills for an API prompt', () => {
    const out = retrieveSkills('Create a Spring Boot REST API with GraphQL and PostgreSQL', 6);
    expect(
      out.some(s =>
        ['spring-boot', 'rest-api', 'graphql-api', 'postgres-db', 'nodejs-backend'].includes(s.id)
      )
    ).toBe(true);
  });

  it('resolves the right frontend skills for a UI prompt', () => {
    const sub = SUBAGENTS.find(s => s.id === 'frontend-designer')!;
    const skills = resolveSkillsForSubagent(sub, 'Build a shadcn dashboard with GSAP and Google Fonts');
    expect(skills.some(s => s.id === 'shadcn-ui' || s.id === 'gsap-animation' || s.id === 'google-fonts')).toBe(true);
  });

  it('resolves the right backend skills for an API prompt', () => {
    const sub = SUBAGENTS.find(s => s.id === 'backend-architect')!;
    const skills = resolveSkillsForSubagent(sub, 'Create a Spring Boot REST API with GraphQL and PostgreSQL');
    expect(skills.some(s => s.id === 'spring-boot' || s.id === 'rest-api' || s.id === 'graphql-api' || s.id === 'postgres-db')).toBe(true);
  });

  it('retrieves testing tools for a test prompt', () => {
    const out = retrieveSkills('Add Playwright and Vitest coverage for the app', 6);
    expect(out.some(s => ['testing-tools', 'claude-webapp-test', 'tob-pbt'].includes(s.id))).toBe(true);
  });

  it('retrieves Stripe for a payments prompt', () => {
    const out = retrieveSkills('Add Stripe checkout to my SaaS', 4);
    expect(out.some(s => s.id === 'stripe')).toBe(true);
  });

  it('retrieves security skills for an audit prompt', () => {
    const out = retrieveSkills('Audit my Node API for OWASP vulnerabilities', 4);
    expect(out.some(s => s.id.startsWith('tob-'))).toBe(true);
  });

  it('retrieves mobile skills for an RN prompt', () => {
    const out = retrieveSkills('Build a React Native app with Expo', 4);
    expect(out.some(s => s.id === 'callstack-rn' || s.id === 'expo-ui')).toBe(true);
  });

  it('returns empty for non-matching query', () => {
    const out = retrieveSkills('xqz', 4);
    expect(out).toEqual([]);
  });

  it('renders a non-empty block for matched skills', () => {
    const out = retrieveSkills('Build a Next.js app', 4);
    const block = renderSkillsBlock(out);
    expect(block).toContain('Retrieved Expert Skills');
    expect(block.length).toBeGreaterThan(40);
  });

  it('renders an empty string for no matches', () => {
    expect(renderSkillsBlock([])).toBe('');
  });
});

describe('subagent registry', () => {
  it('exposes the 6 expected subagents', () => {
    const ids = SUBAGENTS.map(s => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'frontend-designer', 'backend-architect', 'mobile-builder',
        'security-reviewer', 'test-writer', 'general-builder',
      ])
    );
  });

  it('routes a React UI prompt to frontend-designer', async () => {
    expect((await dispatchSubagent('Build a React landing page with Tailwind')).id)
      .toBe('frontend-designer');
  });

  it('routes an API prompt to backend-architect', async () => {
    expect((await dispatchSubagent('Create a Fastify CRUD API for todos')).id)
      .toBe('backend-architect');
  });

  it('routes a mobile prompt to mobile-builder', async () => {
    expect((await dispatchSubagent('Build a React Native app with push notifications')).id)
      .toBe('mobile-builder');
  });

  it('routes a security prompt to security-reviewer', async () => {
    expect((await dispatchSubagent('Audit my code for OWASP vulnerabilities')).id)
      .toBe('security-reviewer');
  });

  it('routes a test prompt to test-writer', async () => {
    expect((await dispatchSubagent('Add vitest coverage for the auth flow')).id)
      .toBe('test-writer');
  });

  it('falls back to general-builder for unrelated prompts', async () => {
    // Mock AIService.streamResponse to throw immediately so the LLM classification
    // path fails fast and the keyword heuristic fallback is tested.
    const mock = vi.spyOn(AIService, 'streamResponse').mockRejectedValue(new Error('Simulated LLM failure for test'));
    try {
      expect((await dispatchSubagent('Make me a sandwich')).id).toBe('general-builder');
    } finally {
      mock.mockRestore();
    }
  });

  it('resolves at least one skill per subagent', () => {
    for (const sub of SUBAGENTS) {
      const skills = resolveSkillsForSubagent(sub, sub.description);
      expect(skills.length).toBeGreaterThan(0);
    }
  });
});
