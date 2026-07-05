// src/examples/index.ts
//
// Lightweight registry of few-shot exemplars used by the agent to anchor
// generation to a gold-standard output for common categories.
//
// Exemplar bodies are embedded as string constants so they survive webpack
// bundling. No runtime file I/O.

export type ExemplarCategory =
  | 'landing-page-react'
  | 'crud-api-node'
  | 'bug-investigation'
  | 'project-scaffold';

export interface Exemplar {
  category: ExemplarCategory;
  prompt: string;
  keywords: string[];
}

/** Inline exemplar content — webpack-safe, no fs/path needed at runtime. */
const EXEMPLAR_BODIES: Record<ExemplarCategory, string> = {
  'landing-page-react': `# Few-shot Exemplar: Landing Page in React + Tailwind

## Prompt

> Build a single-page marketing site for a fictional dev tool called
> **Quill** with: hero, features grid (3 cards), pricing (3 tiers), FAQ
> (5 questions), and footer. Use React 18 + Vite + Tailwind v3. The hero
> should have a big headline, sub-headline, and two CTA buttons. Keep it
> responsive (mobile-first) and accessible (semantic HTML, ARIA labels,
> focus styles). No external CSS frameworks beyond Tailwind.

## Gold-standard output

\`\`\`tsx
// src/App.tsx
import { useState } from 'react';
import Hero from './components/Hero';
import Features from './components/Features';
import Pricing from './components/Pricing';
import Faq from './components/Faq';
import Footer from './components/Footer';

export default function App() {
  return (
    <main className="min-h-screen bg-white text-slate-900">
      <Hero />
      <Features />
      <Pricing />
      <Faq />
      <Footer />
    </main>
  );
}
\`\`\`

\`\`\`tsx
// src/components/Hero.tsx
export default function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="px-6 py-24 text-center sm:py-32 lg:py-40">
      <h1 id="hero-heading" className="text-4xl font-bold tracking-tight sm:text-6xl">
        Ship docs, not dread.
      </h1>
      <p className="mx-auto mt-6 max-w-xl text-lg text-slate-600">
        Quill turns messy Markdown drafts into polished documentation
        with one command.
      </p>
      <div className="mt-10 flex justify-center gap-4">
        <a href="#pricing" className="rounded-md bg-slate-900 px-6 py-3 font-medium text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2">
          Get started
        </a>
        <a href="#features" className="rounded-md border border-slate-300 px-6 py-3 font-medium hover:bg-slate-50">
          Learn more
        </a>
      </div>
    </section>
  );
}
\`\`\`

## Why this is the gold standard

- **Semantic HTML** (\\\`<main>\\\`, \\\`<section aria-labelledby>\\\`, \\\`<h1>\\\` with id).
- **Mobile-first Tailwind** (\\\`px-6\\\`, \\\`sm:py-32\\\`).
- **Accessible focus styles** (\\\`focus:ring-2\\\`).
- **No placeholder code** — every component is fully implemented.
- **No invented dependencies** — uses what's already in the repo.`,

  'crud-api-node': `# Few-shot Exemplar: CRUD API in Node

## Prompt

> Build a minimal CRUD API for \\\`todos\\\` with: GET /todos, GET /todos/:id,
> POST /todos, PUT /todos/:id, DELETE /todos/:id. Use Fastify + better-sqlite3.
> Each todo has \\\`id\\\`, \\\`title\\\`, \\\`done\\\`, \\\`createdAt\\\`. Include input validation
> with Zod and a vitest suite covering happy paths.

## Gold-standard output

\`\`\`ts
// src/server.ts
import Fastify from 'fastify';
import { todosRouter } from './routes/todos';

const app = Fastify({ logger: true });
app.register(todosRouter, { prefix: '/todos' });

const start = async () => {
  try {
    await app.listen({ port: 3000 });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};
start();
\`\`\`

\`\`\`ts
// src/routes/todos.ts
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { TodoRepo } from '../repo';

const createSchema = z.object({ title: z.string().min(1).max(200) });
const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  done: z.boolean().optional(),
});

export async function todosRouter(app: FastifyInstance) {
  const repo = new TodoRepo();

  app.get('/', async () => repo.list());
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const todo = repo.get(Number(req.params.id));
    if (!todo) return reply.code(404).send({ error: 'not found' });
    return todo;
  });
  app.post('/', async (req, reply) => {
    const body = createSchema.parse(req.body);
    const todo = repo.create(body.title);
    return reply.code(201).send(todo);
  });
  app.put<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const body = updateSchema.parse(req.body);
    const todo = repo.update(Number(req.params.id), body);
    if (!todo) return reply.code(404).send({ error: 'not found' });
    return todo;
  });
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const ok = repo.delete(Number(req.params.id));
    return reply.code(ok ? 204 : 404).send();
  });
}
\`\`\`

\`\`\`ts
// src/repo.ts
import Database from 'better-sqlite3';

export interface Todo { id: number; title: string; done: boolean; createdAt: string; }

export class TodoRepo {
  private db = new Database(':memory:');
  constructor() {
    this.db.exec(\`CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );\`);
  }
  list(): Todo[] { return this.db.prepare('SELECT * FROM todos ORDER BY id DESC').all() as Todo[]; }
  get(id: number): Todo | undefined { return this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as Todo | undefined; }
  create(title: string): Todo {
    const info = this.db.prepare('INSERT INTO todos (title) VALUES (?)').run(title);
    return this.get(Number(info.lastInsertRowid))!;
  }
  update(id: number, patch: Partial<Pick<Todo, 'title' | 'done'>>): Todo | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const merged = { ...current, ...patch };
    this.db.prepare('UPDATE todos SET title = ?, done = ? WHERE id = ?').run(merged.title, merged.done ? 1 : 0, id);
    return merged;
  }
  delete(id: number): boolean { return this.db.prepare('DELETE FROM todos WHERE id = ?').run(id).changes > 0; }
}
\`\`\`

\`\`\`ts
// src/repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TodoRepo } from './repo';

describe('TodoRepo', () => {
  let repo: TodoRepo;
  beforeEach(() => { repo = new TodoRepo(); });
  it('creates and lists todos', () => {
    const t = repo.create('write docs');
    expect(t.title).toBe('write docs');
    expect(t.done).toBe(false);
    expect(repo.list()).toHaveLength(1);
  });
  it('updates a todo', () => {
    const t = repo.create('a');
    const updated = repo.update(t.id, { done: true });
    expect(updated?.done).toBe(true);
  });
  it('returns undefined for unknown ids', () => {
    expect(repo.get(999)).toBeUndefined();
    expect(repo.update(999, { done: true })).toBeUndefined();
    expect(repo.delete(999)).toBe(false);
  });
});
\`\`\`

## Why this is the gold standard

- **Validation at the edge** (Zod parses every request body).
- **Typed Fastify generics** (\\\`Params: { id: string }\\\`).
- **Tests cover happy + error paths**, run with \\\`npm run test:unit\\\`.
- **No N+1 queries** — single prepared statements.
- **No \\\`any\\\`** — \\\`Todo\\\` interface drives the repo.`,

  'bug-investigation': `# Few-shot Exemplar: Bug Investigation

## Prompt

> Users report \\\`TypeError: Cannot read properties of undefined (reading
> 'map')\\\` from the sidebar chat after upgrading to v1.0.0. Stack trace
> points to \\\`src/sidebar-provider.ts#L120\\\`. Reproduce locally, find the
> root cause, propose a minimal fix.

## Investigation log

1. Read \\\`src/sidebar-provider.ts#L115-L130\\\` — \\\`chatHistory\\\` is being \\\`map\\\`-ed.
2. \\\`chatHistory\\\` is populated by \\\`agent-graph.ts\\\` which now writes to \\\`chatHistory\\\` (renamed from \\\`messages\\\` in v1.0.0).
3. **Root cause:** the message reducer returns \\\`undefined\\\` on the first turn because \\\`existing\\\` is \\\`undefined\\\` and \\\`incoming\\\` is also undefined during the empty-state bootstrap.
4. **Fix:** default the reducer to \\\`[]\\\` and filter undefined entries.

## Minimal patch

\`\`\`diff
- chatHistory: Annotation<ChatMessage[]>({
-   reducer: (existing, incoming) => existing.concat(incoming),
+ chatHistory: Annotation<ChatMessage[]>({
+   reducer: (existing, incoming) => {
+     const base = existing ?? [];
+     return incoming ? base.concat(incoming) : base;
+   },
    default: () => [],
  }),
\`\`\`

## Verification

\`\`\`bash
npm run test:unit -- src/test/sidebar-provider.test.ts  # new test added
npm run compile                                        # passes
\`\`\`

## Why this is the gold standard

- **Reproduction first** (read the line number, not guess).
- **Root cause, not symptom** (the reducer, not the consumer).
- **Minimal diff** (5 lines, no refactor).
- **Test added** for the regression.
- **Verification run** before declaring done.`,

  'project-scaffold': `# Few-shot Exemplar: Project Scaffolding

## Prompt

> Build a React + Vite + TypeScript website for a task manager app.

## Gold-standard Response

### Step 1: Check existing files

The workspace is empty. No package.json exists. The first step is ALWAYS to create package.json.

### Step 2: Create package.json with npm init

\`\`\`bash
npm init -y
\`\`\`

This creates a baseline package.json. The agent can then read it and start editing.

### Step 3: Create config files

Create tsconfig.json, vite.config.ts, tailwind.config.js, postcss.config.js.

### Step 4: Install dependencies

\`\`\`bash
npm install react react-dom
npm install -D typescript @types/react @types/react-dom vite @vitejs/plugin-react tailwindcss postcss autoprefixer
\`\`\`

### Step 5: Create source files

- index.html (Vite entry point)
- src/main.tsx (React entry)
- src/App.tsx (root component)
- src/index.css (Tailwind directives)

### Step 6: Create index.html

The Vite entry must reference /src/main.tsx.

### Step 7: Verify

\`\`\`bash
npm run dev
\`\`\`

## Key Rules

1. **ALWAYS create package.json first** — never npm install before package.json exists.
2. **Use npm init -y** for quick scaffolding, then edit the package.json.
3. **Framework CLIs** (create-vite, npx create-next-app) can replace steps 2-5, but the agent must use runCommand for these.
4. **Run npm install AFTER package.json is complete** with all dependencies listed.
5. **Create ALL source files before running dev server**.`,

};

const EXEMPLARS: Exemplar[] = [
  {
    category: 'landing-page-react',
    prompt: 'Build a single-page marketing site',
    keywords: ['landing', 'marketing', 'hero', 'pricing', 'react', 'tailwind', 'homepage'],
  },
  {
    category: 'crud-api-node',
    prompt: 'Build a CRUD API',
    keywords: ['crud', 'api', 'rest', 'fastify', 'express', 'todo', 'endpoint'],
  },
  {
    category: 'bug-investigation',
    prompt: 'Investigate a bug from a stack trace',
    keywords: ['bug', 'stack trace', 'error', 'investigate', 'regression', 'fix'],
  },
  {
    category: 'project-scaffold',
    prompt: 'Scaffold a new project from scratch',
    keywords: ['build', 'create', 'new', 'scaffold', 'init', 'setup', 'project', 'website', 'app', 'site', 'boilerplate', 'template', 'starter', 'npm init', 'package.json'],
  },
];

export function listExemplars(): Exemplar[] {
  return EXEMPLARS.slice();
}

export function pickExemplar(query: string): Exemplar | null {
  const q = query.toLowerCase();
  let best: { ex: Exemplar; score: number } | null = null;
  for (const ex of EXEMPLARS) {
    let score = 0;
    for (const kw of ex.keywords) {
      if (q.includes(kw)) score += 1;
    }
    if (q.includes(ex.category.replace(/-/g, ' '))) score += 2;
    if (score > 0 && (!best || score > best.score)) {
      best = { ex, score };
    }
  }
  return best ? best.ex : null;
}

/** Returns the embedded exemplar body for a given category (webpack-safe). */
export function loadExemplar(category: ExemplarCategory): string {
  return EXEMPLAR_BODIES[category] || '';
}
