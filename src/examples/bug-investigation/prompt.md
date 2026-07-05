# Few-shot Exemplar: Bug Investigation

## Prompt

> Users report `TypeError: Cannot read properties of undefined (reading
> 'map')` from the sidebar chat after upgrading to v1.0.0. Stack trace
> points to `src/sidebar-provider.ts#L120`. Reproduce locally, find the
> root cause, propose a minimal fix.

## Investigation log

1. Read [`src/sidebar-provider.ts`](src/sidebar-provider.ts#L115-L130) —
   `chatHistory` is being `map`-ed.
2. `chatHistory` is populated by [`agent-graph.ts`](src/agent-graph.ts)
   which now writes to `chatHistory` (renamed from `messages` in v1.0.0).
3. **Root cause:** the message reducer returns `undefined` on the first
   turn because `existing` is `undefined` and `incoming` is also
   undefined during the empty-state bootstrap.
4. **Fix:** default the reducer to `[]` and filter undefined entries.

## Minimal patch

```diff
- chatHistory: Annotation<ChatMessage[]>({
-   reducer: (existing, incoming) => existing.concat(incoming),
+ chatHistory: Annotation<ChatMessage[]>({
+   reducer: (existing, incoming) => {
+     const base = existing ?? [];
+     return incoming ? base.concat(incoming) : base;
+   },
    default: () => [],
  }),
```

## Verification

```bash
npm run test:unit -- src/test/sidebar-provider.test.ts  # new test added
npm run compile                                        # passes
```

## Why this is the gold standard

- **Reproduction first** (read the line number, not guess).
- **Root cause, not symptom** (the reducer, not the consumer).
- **Minimal diff** (5 lines, no refactor).
- **Test added** for the regression.
- **Verification run** before declaring done.
