# Few-shot Exemplar: CRUD API in Node

## Prompt

> Build a minimal CRUD API for `todos` with: GET /todos, GET /todos/:id,
> POST /todos, PUT /todos/:id, DELETE /todos/:id. Use Fastify + better-sqlite3.
> Each todo has `id`, `title`, `done`, `createdAt`. Include input validation
> with Zod and a vitest suite covering happy paths.

## Gold-standard output

```ts
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
```

```ts
// src/routes/todos.ts
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { TodoRepo } from '../repo';

const createSchema = z.object({
  title: z.string().min(1).max(200),
});

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
```

```ts
// src/repo.ts
import Database from 'better-sqlite3';

export interface Todo {
  id: number;
  title: string;
  done: boolean;
  createdAt: string;
}

export class TodoRepo {
  private db = new Database(':memory:');

  constructor() {
    this.db.exec(`
      CREATE TABLE todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  list(): Todo[] {
    return this.db.prepare('SELECT * FROM todos ORDER BY id DESC').all() as Todo[];
  }
  get(id: number): Todo | undefined {
    return this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as Todo | undefined;
  }
  create(title: string): Todo {
    const info = this.db.prepare('INSERT INTO todos (title) VALUES (?)').run(title);
    return this.get(Number(info.lastInsertRowid))!;
  }
  update(id: number, patch: Partial<Pick<Todo, 'title' | 'done'>>): Todo | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const merged = { ...current, ...patch };
    this.db.prepare('UPDATE todos SET title = ?, done = ? WHERE id = ?')
      .run(merged.title, merged.done ? 1 : 0, id);
    return merged;
  }
  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM todos WHERE id = ?').run(id).changes > 0;
  }
}
```

```ts
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
```

## Why this is the gold standard

- **Validation at the edge** (Zod parses every request body).
- **Typed Fastify generics** (`Params: { id: string }`).
- **Tests cover happy + error paths**, run with `npm run test:unit`.
- **No N+1 queries** — single prepared statements.
- **No `any`** — `Todo` interface drives the repo.
