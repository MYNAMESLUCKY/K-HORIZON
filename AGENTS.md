# AGENTS.md — Agent Operating Manual

> How this repo's agents (Copilot, custom subagents in
> [`src/agent-graph.ts`](src/agent-graph.ts), and any automated assistant)
> should behave when working on K-HORIZON.

---

## 1. Mission

Produce **amazing software** — websites, apps, APIs, CLIs — by combining:

1. Authoritative skills (RAG over 1,500+ curated best-practice skills).
2. Repo-level rules ([`.github/copilot-instructions.md`](.github/copilot-instructions.md)).
3. Few-shot exemplars in `src/examples/`.
4. Real tools via MCP (filesystem, git, playwright, db, deploy).
5. A mandatory verification loop.

---

## 2. Skills-first RAG (awesome-agent-skills)

The repo includes the `awesome-agent-skills` skill under
`~/.copilot/skills/awesome-agent-skills/`. It catalogs 1,500+ skills from
Claude, Vercel, Stripe, Cloudflare, OpenAI, Microsoft, Trail of Bits,
HashiCorp, Expo, CallStack, and more.

**Procedure before answering a build request:**

1. Parse the request → extract tech / framework / domain.
2. Match against the catalog metadata (tags, description, name).
3. Load **only** the matched skill bodies.
4. Inject them as system-level context for the LLM.
5. Apply the skills in sequence to produce code.

Examples:

| User request | Skills to retrieve |
|---|---|
| "Build a Next.js site with Stripe checkout" | `vercel/next-best-practices`, `vercel/next-cache-components`, `stripe/stripe-best-practices`, `neon/postgres-best-practices` |
| "Audit my Node API for security issues" | `trailofbits/static-analysis`, `trailofbits/insecure-defaults`, `trailofbits/sharp-edges` |
| "Create a React Native app with push notifications" | `callstack/react-native-best-practices`, `expo/building-native-ui`, `better-auth/create-auth` |
| "Deploy a Cloudflare Worker that proxies OpenAI" | `cloudflare/agents-sdk`, `cloudflare/workers-best-practices`, `openai/frontend-skill` |
| "Build a landing page in React + Tailwind" | `anthropics/frontend-design`, `google-labs-stitch/react-components`, `anthropics/canvas-design` |

The catalog lives at
[`references/awesome-agent-skills-catalog.md`](references/awesome-agent-skills-catalog.md)
in the user-level skills directory.

---

## 3. Subagent roster (in [`src/agent-graph.ts`](src/agent-graph.ts))

Each subagent is a named profile with:

- A **system prompt** tailored to its domain.
- A **tool allow-list** (e.g. `mobile-builder` cannot run `git push`).
- A **skill bundle** loaded from the catalog.
- A **default model** (lighter model for `test-writer`, stronger model for `backend-architect`).

| Subagent | Domain | Default model | Skill bundle |
|---|---|---|---|
| `frontend-designer` | UI/UX, React, Next, Tailwind, CSS, HTML | `chatModel` | `anthropics/frontend-design`, `anthropics/web-artifacts-builder`, `google-labs-stitch/react-components`, `google-labs-stitch/shadcn-ui` |
| `backend-architect` | APIs, DBs, auth, queues, serverless | `chatModel` | `microsoft/cloud-solution-architect`, `neon/postgres-best-practices`, `better-auth/best-practices`, `vercel/next-best-practices` |
| `mobile-builder` | React Native, Expo, iOS/Android | `chatModel` | `callstack/react-native-best-practices`, `expo/building-native-ui`, `expo/native-data-fetching`, `better-auth/create-auth` |
| `security-reviewer` | Audits, secrets, OWASP, supply chain | `chatModel` | `trailofbits/building-secure-contracts`, `trailofbits/static-analysis`, `trailofbits/insecure-defaults`, `trailofbits/sharp-edges` |
| `test-writer` | Vitest, Playwright, snapshot tests | `plannerModel` | `anthropics/webapp-testing`, `sentry/sentry-react-native-sdk`, `trailofbits/property-based-testing` |
| `general-builder` | Catch-all for anything not covered above | `chatModel` | (none — falls back to general knowledge) |

Dispatch logic in `agent-graph.ts`:

- If the prompt mentions a frontend keyword (React, Next, Tailwind, HTML,
  CSS, "landing page", "UI") → `frontend-designer`.
- If backend / API / DB / auth → `backend-architect`.
- If mobile / iOS / Android / React Native → `mobile-builder`.
- If "audit", "review", "security", "vulnerability" → `security-reviewer`.
- If "test", "spec", "coverage" → `test-writer`.
- Otherwise → `general-builder`.

---

## 4. Verification loop (non-negotiable)

Every code change must self-verify:

````bash
npm run test:unit     # fast vitest pass
npm run compile       # webpack production build
````

If `compile` fails, the agent enters `compileHealAttempts` (max 3).
If `test` fails, the agent enters `testHealAttempts` (max 3).
After either budget is exhausted, the agent reports the failure clearly.

For UI changes, the agent should additionally:

1. Spin up a Playwright MCP server (see [`src/mcp-manager.ts`](src/mcp-manager.ts)).
2. Screenshot the rendered page.
3. Confirm no console errors.

---

## 5. Tool-call contract (JSON-first)

The LLM is asked to emit **JSON tool calls** — not XML. The shape is the same
one every tool already accepts in its `arguments` field:

````json
{"name": "read_file", "arguments": {"file_path": "src/example.ts"}}
````

Multiple calls can be emitted as an array:

````json
[
  {"name": "read_file", "arguments": {"file_path": "src/a.ts"}},
  {"name": "grep_search", "arguments": {"query": "TODO"}}
]
````

Keys (`name`, `arguments`) are case-sensitive. `arguments` may be missing
or empty (`{}`) for tools that take no inputs. Optional aliases
`args` and `parameters` are accepted as fallbacks.

[`ToolManager.parseToolCalls`](src/tool-manager.ts) runs the JSON stage
first. If no JSON tool calls are found, it falls back to the original
XML/DSML parsers so older model traces still replay. Always emit JSON —
the fallback is only there for compatibility.

---

## 6. Few-shot exemplars (`src/examples/`)

Each exemplar is a `prompt.md` + `solution/` pair demonstrating the **gold
standard** output for a category. Inject the most similar exemplar into the
LLM prompt before generation.

| Exemplar | Teaches |
|---|---|
| `landing-page-react/` | Marketing site, hero, pricing, footer |
| `crud-api-node/` | Express/Fastify CRUD with Postgres + tests |
| `mobile-screen-rn/` | React Native screen with auth-gated data |
| `legacy-refactor/` | Refactor 200-line file into 3 modules |
| `bug-investigation/` | Stack trace → root cause → minimal fix |

When adding a new exemplar, keep it self-contained and runnable.

---

## 7. Tone of voice

- Direct, professional, no fluff.
- Code first, explanation after.
- Cite the file path and line numbers when discussing code
  (e.g. `src/agent-graph.ts#L42`).
- Never apologize for following the rules. Just do the work.

---

## 8. Anti-patterns (do not do)

- ❌ Fine-tuning on a tiny dataset — use RAG instead.
- ❌ Loading the entire skills catalog into context — RAG retrieves only what's relevant.
- ❌ Skipping verification after edits.
- ❌ Hallucinating tool signatures — always read
  [`src/tool-manager.ts`](src/tool-manager.ts) before inventing new tools.
- ❌ Returning placeholder code (`// TODO implement later`).
