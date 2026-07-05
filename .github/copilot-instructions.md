# K-HORIZON — Copilot Instructions

> Authoritative coding rules for the K-HORIZON VS Code extension (the workspace in
> `c:\Users\ramas\OneDrive\Desktop\microservices`). Read this before suggesting or
> writing code.

---

## 1. Project summary

K-HORIZON is a token-efficient AI coding assistant that lives inside VS Code. It
duplicates the core Cursor experience — inline edits, sidebar chat, composer for
multi-file changes, ghost-text autocomplete — and routes everything through an
agent graph built on `@langchain/langgraph`.

Key entry points:

| Surface | File |
|---|---|
| Extension activation, command wiring | [`src/extension.ts`](src/extension.ts) |
| Sidebar chat UI + provider | [`src/sidebar-provider.ts`](src/sidebar-provider.ts) |
| Inline edits | [`src/inline-edit.ts`](src/inline-edit.ts) |
| Composer (multi-file edits) | [`src/composer-provider.ts`](src/composer-provider.ts) |
| Autocomplete | [`src/autocomplete-provider.ts`](src/autocomplete-provider.ts) |
| Agent graph (LLM ↔ tool loop) | [`src/agent-graph.ts`](src/agent-graph.ts) |
| Tool registry + JSON/XML parsing | [`src/tool-manager.ts`](src/tool-manager.ts) |
| MCP server lifecycle | [`src/mcp-manager.ts`](src/mcp-manager.ts) |
| Vector RAG (Supabase + aicredits.in) | [`src/rag-service.ts`](src/rag-service.ts) |
| LLM provider abstraction | [`src/ai-service.ts`](src/ai-service.ts) |
| Verification command detection | [`src/verification-commands.ts`](src/verification-commands.ts) |

---

## 2. Hard rules (never break these)

1. **State field naming.** The conversation channel in [`src/agent-graph.ts`](src/agent-graph.ts)
   is named `chatHistory` — **not** `messages`. Do not rename it. Using `messages`
   collides with `@langchain/core`'s internal channel validation and breaks the
   graph at runtime.
2. **No `any` in public APIs.** Public class methods accept typed objects. Local
   helpers may use `any` for tool-call payloads but must narrow before returning.
3. **No new top-level dependencies** without explicit user approval. Use what's in
   [`package.json`](package.json) (`@langchain/*`, `pg`, `cheerio`, `playwright-core`).
4. **Tool calls are JSON-first, XML as graceful fallback.** The LLM emits
   JSON tool calls — `{ "name": "...", "arguments": {...} }` or an array of
   such objects (see AGENTS.md §5). The parser in
   [`ToolManager.parseToolCalls`](src/tool-manager.ts) runs JSON first; if no
   JSON tool calls are found, it falls back to the original XML/DSML parsers
   so older model traces still replay. New tools must accept the same
   `{ name, arguments }` shape.
5. **Verification before declaring success.** Any change to a `.ts` file must pass
   `npm run compile`. Code changes touching public APIs must also pass
   `npm run test:unit`.
6. **No `console.log` in production paths.** Use `console.error` for caught
   exceptions; debug logs should go through `AgentTrace`.
7. **Search/replace blocks are the contract.** Composer uses the
   `<<<<<<< SEARCH ======= >>>>>>> REPLACE` format. Do not switch to JSON or
   diff hunks without updating [`DiffHandler`](src/diff-handler.ts).

---

## 3. Coding conventions

- TypeScript strict mode (`"strict": true` in [`tsconfig.json`](tsconfig.json)).
  No `// @ts-ignore` without a written justification comment above it.
- Prefer `async/await` over `.then()` chains.
- Imports use the workspace-relative path (`./ai-service`), not deep aliases.
- File header docs use `/** ... */` JSDoc on exported classes/functions.
- Long-running operations (LLM calls, DB queries) accept a
  `vscode.CancellationToken` and bail early when cancellation is requested.

---

## 4. Verification loop (every code change)

Run, in order:

````bash
npm run test:unit     # fast vitest pass
npm run compile       # webpack production build — catches type errors
````

If either fails, **fix it before continuing**. The agent graph's self-heal
phase (`compileHealAttempts`, `testHealAttempts`) handles transient failures
but it cannot recover from a fundamentally broken build.

---

## 5. Subagents (see [`src/agent-graph.ts`](src/agent-graph.ts))

| Subagent | When to dispatch |
|---|---|
| `frontend-designer` | React/Next/CSS/Tailwind/HTML UI tasks |
| `backend-architect` | Node/Go/Python APIs, DB schemas, auth |
| `mobile-builder` | React Native, Expo, native iOS/Android |
| `security-reviewer` | Audits, dependency review, secrets, OWASP |
| `test-writer` | Adds/maintains vitest suites, Playwright e2e |
| `general-builder` | Default fallback for anything else |

Each subagent loads a curated skill set from the awesome-agent-skills RAG —
see [`AGENTS.md`](AGENTS.md).

---

## 6. RAG-first rule

Before the LLM answers any non-trivial prompt, it must call
`RAGService.retrieveContext(query)`. For "how do I build X" prompts it must
also load the relevant skills (see [`AGENTS.md`](AGENTS.md)).

---

## 7. Style preferences

- Comments explain *why*, not *what*. Self-evident code stays uncommented.
- Prefer small, named functions over deeply nested anonymous lambdas.
- Keep files under ~500 lines. Split when a file grows beyond that.
