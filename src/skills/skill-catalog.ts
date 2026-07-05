// src/skills/skill-catalog.ts
//
// Curated, lightweight index of the awesome-agent-skills RAG catalog.
// This is what the agent queries on every build request to load only the
// relevant skills (1–4 per request) instead of dumping the full 1,500+.
//
// Source: ~/.copilot/skills/awesome-agent-skills/references/awesome-agent-skills-catalog.md
// To refresh: copy a 50-line excerpt from the full catalog into TOP_SKILLS
// below. Keep entries tiny — they are matched by keyword, not loaded in full.

export interface SkillEntry {
  id: string;
  name: string;
  tags: string[];
  description: string;
  url: string;
  /** Inline skill body content. When present, this is injected into the system prompt directly
   *  instead of requiring the LLM to fetch the URL. Preferred for high-frequency skills. */
  body?: string;
}

const SKILL_INDEX = new Map<string, SkillEntry>();

function normalizeSkillText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

/**
 * The top 30 skills most commonly needed for software-building tasks.
 * Each entry is matched by tag/keyword against the user's prompt.
 * Full bodies are fetched on demand from `url` via the RAG pipeline.
 */
export const TOP_SKILLS: SkillEntry[] = [
  // Project Scaffolding (inline body — critical for new projects)
  { id: 'project-scaffold', name: 'Project Scaffolding', tags: ['scaffold', 'init', 'create', 'new', 'project', 'setup', 'website', 'app', 'build', 'starter', 'boilerplate', 'template'], description: 'How to scaffold new projects from scratch.', url: '', body: `# Project Scaffolding Best Practices

## When to scaffold
- The workspace has no \`package.json\` (check with \`list_dir\` first).
- The user asks to "build", "create", "make", "scaffold", or "start" a new project.

## Scaffolding sequence (MUST follow this order)
1. **Create package.json**: \`npm init -y\` at workspace root.
2. **For framework projects**, use the framework CLI in the SAME directory:
   - Vite + React + TypeScript: \`npm create vite@latest . -- --template react-ts\`
   - Vite + Vanilla TS: \`npm create vite@latest . -- --template vanilla-ts\`
   - Next.js: \`npx create-next-app@latest .\`
   - React (CRA): \`npx create-react-app .\`
3. **Install dependencies**: \`npm install\` (after framework CLI, it's usually done automatically; otherwise run manually).
4. **Create config files**: \`tsconfig.json\`, \`vite.config.ts\`, \`tailwind.config.js\`, \`postcss.config.js\` as needed.
5. **Create source files**: \`index.html\`, \`src/main.tsx\`, \`src/App.tsx\`, \`src/index.css\`.
6. **Verify**: \`npm run build\` (or \`npm run dev\` for dev server).

## Key rules
- Never run \`npm install <pkg>\` before \`npm init -y\`.
- Use the \`directory\` parameter ONLY when scaffolding in a subfolder.
- \`npm init\` and \`npm create\` are always allowed — they don't need a pre-existing package.json.
- After framework CLI, check if \`node_modules\` exists; if not, run \`npm install\`.
- If \`npm create vite\` fails, fall back to \`npm init -y\` + manual file creation.` },

  // Frontend
  { id: 'claude-frontend-design', name: 'Frontend Design', tags: ['react', 'ui', 'css', 'tailwind', 'html', 'design', 'frontend', 'landing'], description: 'Frontend design and UI/UX development tools.', url: 'https://officialskills.sh/anthropics/skills/frontend-design', body: `# Frontend Design Best Practices

## Layout
- Mobile-first responsive design: start with smallest screen, add breakpoints up.
- Use CSS Grid for page layout, Flexbox for component layout.
- Max-width containers (max-w-7xl mx-auto) for readable content width.
- Consistent spacing scale: 4, 8, 12, 16, 24, 32, 48, 64, 96 px.

## Accessibility
- Semantic HTML: <header>, <nav>, <main>, <section>, <article>, <footer>.
- Every <img> needs alt text. Every <input> needs a <label>.
- aria-label on interactive elements without visible text.
- Visible focus rings (focus:ring-2 focus:ring-offset-2).
- Color contrast ratio >= 4.5:1 for text.

## Performance
- Lazy-load images (loading="lazy").
- Minimize layout shift (explicit width/height on images).
- Prefer CSS transforms over layout-triggering properties.` },

  // TypeScript (inline body)
  { id: 'ms-typescript', name: 'TypeScript Best Practices', tags: ['typescript', 'ts', 'javascript', 'js'], description: 'TypeScript coding best practices.', url: 'https://officialskills.sh/microsoft/skills/typescript', body: `# TypeScript Best Practices

## Project Config
- Enable strict mode in tsconfig.json.
- Use ES modules (module: "ESNext", moduleResolution: "bundler").
- Target ES2020+ for modern browsers, include DOM lib for web projects.
- Set jsx: "react-jsx" for React 17+ projects.

## Coding
- Prefer interfaces over type aliases for object shapes.
- Use readonly for immutable data, as const for literal tuples.
- Exhaustive switch: use never type in default branch.
- Async functions should return Promise<T>, never void for fire-and-forget.
- Use unknown over any in catch clauses.
- Template literal types for string manipulation.` },

  // Frontend (continued)
  { id: 'claude-web-artifacts', name: 'Web Artifacts Builder', tags: ['react', 'tailwind', 'html', 'artifacts', 'web'], description: 'Build complex HTML artifacts with React and Tailwind.', url: 'https://officialskills.sh/anthropics/skills/web-artifacts-builder' },
  { id: 'stitch-react', name: 'Stitch React Components', tags: ['react', 'stitch', 'components', 'figma', 'shadcn'], description: 'Convert designs into React components.', url: 'https://officialskills.sh/google-labs-stitch/skills/react-components' },
  { id: 'stitch-shadcn', name: 'Stitch shadcn/ui', tags: ['react', 'shadcn', 'ui', 'components'], description: 'Generate shadcn/ui-based interfaces.', url: 'https://officialskills.sh/google-labs-stitch/skills/shadcn-ui' },
  { id: 'openai-frontend', name: 'OpenAI Frontend Skill', tags: ['frontend', 'react', 'next', 'ui'], description: 'Frontend best practices for OpenAI apps.', url: 'https://officialskills.sh/openai/skills/frontend-skill' },

  // UI libraries / animation / assets
  { id: 'gsap-animation', name: 'GSAP Animation', tags: ['gsap', 'gasp', 'animation', 'motion', 'timeline', 'scrolltrigger'], description: 'High-performance motion design with GSAP.', url: 'https://officialskills.sh/gsap/skills/animation', body: `# GSAP Animation Best Practices

- Animate transform and opacity before layout-triggering properties.
- Use timelines for orchestrating multi-step motion.
- Prefer ScrollTrigger for scroll-linked effects.
- Respect reduced-motion preferences and keep motion subtle.` },
  { id: 'animejs-animation', name: 'Anime.js Animation', tags: ['animejs', 'anime.js', 'animation', 'motion', 'stagger'], description: 'Lightweight declarative animation patterns.', url: 'https://officialskills.sh/animejs/skills/animation', body: `# Anime.js Best Practices

- Use staggered sequences for lists and callouts.
- Keep animations composable and easy to cancel.
- Animate transforms and opacity first.
- Avoid excessive motion; honor reduced-motion settings.` },
  { id: 'shadcn-ui', name: 'shadcn/ui', tags: ['shadcn', 'shadcn/ui', 'radix', 'components', 'tailwind'], description: 'Composable accessible UI primitives for React.', url: 'https://officialskills.sh/google-labs-stitch/skills/shadcn-ui', body: `# shadcn/ui Best Practices

- Build from composable primitives instead of heavy abstractions.
- Keep component APIs small and ergonomic.
- Preserve accessibility semantics for dialogs, menus, and forms.
- Use Tailwind utility classes for consistent styling.` },
  { id: 'google-fonts', name: 'Google Fonts', tags: ['google fonts', 'fonts', 'typography', 'font', 'type'], description: 'Web font loading and typography best practices.', url: 'https://officialskills.sh/google/fonts/skills/best-practices', body: `# Google Fonts Best Practices

- Limit the number of families and weights.
- Preload critical fonts and use font-display: swap.
- Keep typography consistent across heading and body styles.
- Avoid loading unused variants.` },
  { id: 'svgrepo-icons', name: 'SVGRepo Icons', tags: ['svgrepo', 'svg', 'icons', 'illustration', 'assets'], description: 'Reusable SVG icon and asset workflows.', url: 'https://officialskills.sh/svgrepo/skills/icons', body: `# SVG Asset Best Practices

- Prefer inline SVG or sprite usage for app icons.
- Preserve viewBox and optimize paths before shipping.
- Use currentColor when you want theme-aware icons.
- Hide decorative SVGs from assistive tech when appropriate.` },
  { id: 'undraw-illustrations', name: 'unDraw Illustrations', tags: ['undraw', 'illustration', 'svg', 'assets', 'hero'], description: 'Free illustration workflows for product UI.', url: 'https://officialskills.sh/undraw/skills/illustrations', body: `# unDraw Best Practices

- Match illustration colors to the product theme.
- Keep assets lightweight and optimized as SVG.
- Use illustrations to support, not replace, clear copy.
- Mark purely decorative illustrations appropriately.` },
  { id: 'daisyui-components', name: 'daisyUI Components', tags: ['daisyui', 'tailwind', 'components', 'ui', 'themes'], description: 'Tailwind component patterns with daisyUI.', url: 'https://officialskills.sh/daisyui/skills/components', body: `# daisyUI Best Practices

- Use semantic markup with component classes.
- Keep theme usage consistent across the app.
- Override styles sparingly and intentionally.
- Pair daisyUI components with accessible labels and focus states.` },
  { id: 'chartjs-charts', name: 'Chart.js', tags: ['chartjs', 'charts', 'graph', 'dashboard', 'visualization'], description: 'Dashboard and chart visualization patterns.', url: 'https://officialskills.sh/chartjs/skills/charts', body: `# Chart.js Best Practices

- Pick the simplest chart type that answers the question.
- Keep labels readable and tooltips concise.
- Make charts responsive and accessible.
- Avoid animation-heavy dashboards unless it adds value.` },

  // Backend / Cloud
  { id: 'vercel-next-bp', name: 'Next.js Best Practices', tags: ['nextjs', 'next', 'react', 'vercel', 'ssr', 'rsc'], description: 'Next.js best practices.', url: 'https://officialskills.sh/vercel/skills/next-best-practices' },
  { id: 'vercel-cache', name: 'Next.js Cache Components', tags: ['nextjs', 'cache', 'rsc', 'performance'], description: 'Cache components for Next.js.', url: 'https://officialskills.sh/vercel/skills/next-cache-components' },
  { id: 'cloudflare-workers', name: 'Cloudflare Workers', tags: ['cloudflare', 'workers', 'edge', 'serverless'], description: 'Cloudflare Workers best practices.', url: 'https://officialskills.sh/cloudflare/skills/workers-best-practices' },
  { id: 'cloudflare-perf', name: 'Cloudflare Web Perf', tags: ['performance', 'web', 'cloudflare', 'lcp', 'cls'], description: 'Web performance auditing.', url: 'https://officialskills.sh/cloudflare/skills/web-perf' },
  { id: 'neon-postgres', name: 'Neon Postgres', tags: ['postgres', 'sql', 'database', 'neon'], description: 'Postgres best practices on Neon.', url: 'https://officialskills.sh/neon/skills/postgres-best-practices' },
  { id: 'ms-cloud-architect', name: 'Azure Cloud Architect', tags: ['azure', 'cloud', 'architect', 'infrastructure'], description: 'Cloud architecture on Azure.', url: 'https://officialskills.sh/microsoft/skills/cloud-solution-architect' },

  // Backend stacks / APIs / databases
  { id: 'spring-boot', name: 'Spring Boot', tags: ['spring boot', 'spring', 'java', 'backend', 'api', 'rest', 'graphql'], description: 'Spring Boot API and service architecture.', url: 'https://officialskills.sh/spring/skills/boot', body: `# Spring Boot Best Practices

- Organize code into controllers, services, and repositories.
- Validate input at the edge and return clear HTTP errors.
- Prefer DTOs for API boundaries and avoid exposing entities directly.
- Add focused tests for controllers, services, and persistence.` },
  { id: 'rest-api', name: 'REST APIs', tags: ['rest api', 'rest', 'api', 'http', 'openapi', 'endpoint'], description: 'REST API design and implementation patterns.', url: 'https://officialskills.sh/api/skills/rest', body: `# REST API Best Practices

- Use resource nouns and consistent HTTP verbs/status codes.
- Version APIs intentionally and document them with OpenAPI.
- Validate input, paginate collections, and make writes idempotent when possible.
- Protect endpoints with authentication and authorization.` },
  { id: 'graphql-api', name: 'GraphQL APIs', tags: ['graphql', 'schema', 'resolver', 'api', 'n+1'], description: 'GraphQL schema and resolver patterns.', url: 'https://officialskills.sh/api/skills/graphql', body: `# GraphQL Best Practices

- Design a clear schema and keep resolvers small.
- Prevent N+1 queries with batching or dataloaders.
- Control query depth and complexity for safety.
- Keep authorization checks close to the data boundary.` },
  { id: 'nodejs-backend', name: 'Node.js Backend', tags: ['node.js', 'nodejs', 'javascript', 'backend', 'server'], description: 'Node.js backend engineering patterns.', url: 'https://officialskills.sh/nodejs/skills/backend', body: `# Node.js Best Practices

- Prefer async/await and centralize error handling.
- Validate inputs and never trust request payloads.
- Use structured logs and keep long-running work off the main path.
- Split route, service, and data-access layers for maintainability.` },
  { id: 'nextjs-web', name: 'Next.js Web Apps', tags: ['next.js', 'nextjs', 'react', 'ssr', 'rsc', 'app router'], description: 'Next.js app architecture and rendering patterns.', url: 'https://officialskills.sh/vercel/skills/nextjs', body: `# Next.js Best Practices

- Choose server and client components intentionally.
- Use data fetching and caching strategies on purpose, not by habit.
- Keep route handlers and server actions small and testable.
- Favor performance-friendly rendering and loading states.` },
  { id: 'express-api', name: 'Express.js APIs', tags: ['express.js', 'express', 'node', 'api', 'middleware'], description: 'Express routing, middleware, and API structure.', url: 'https://officialskills.sh/express/skills/api', body: `# Express.js Best Practices

- Keep middleware order deliberate and easy to follow.
- Validate inputs before handlers touch business logic.
- Centralize error handling and return consistent JSON responses.
- Add security middleware and avoid leaking internals.` },
  { id: 'flask-api', name: 'Flask APIs', tags: ['flask', 'python', 'api', 'backend', 'microservice'], description: 'Flask API and service patterns.', url: 'https://officialskills.sh/flask/skills/api', body: `# Flask Best Practices

- Use the application factory pattern for scalability.
- Organize blueprints by feature or domain.
- Validate request data and keep route handlers thin.
- Separate configuration from runtime code and test the API surface.` },
  { id: 'django-api', name: 'Django APIs', tags: ['django', 'python', 'api', 'orm', 'backend'], description: 'Django service and ORM patterns.', url: 'https://officialskills.sh/django/skills/api', body: `# Django Best Practices

- Structure code into reusable apps.
- Use the ORM carefully and watch for query count issues.
- Keep serializers, forms, and views focused.
- Add tests for models, permissions, and request flows.` },
  { id: 'mysql-db', name: 'MySQL', tags: ['mysql', 'sql', 'database', 'relational', 'schema'], description: 'MySQL schema and query best practices.', url: 'https://officialskills.sh/mysql/skills/best-practices', body: `# MySQL Best Practices

- Use indexes for common filters and joins.
- Keep schemas normalized unless you have a measured reason not to.
- Use transactions for multi-step writes.
- Choose the right collation and character set for your data.` },
  { id: 'postgres-db', name: 'PostgreSQL', tags: ['postgres sql', 'postgresql', 'postgres', 'postress', 'sql', 'database'], description: 'PostgreSQL schema, query, and migration patterns.', url: 'https://officialskills.sh/postgresql/skills/best-practices', body: `# PostgreSQL Best Practices

- Prefer parameterized queries and migrations.
- Use indexes deliberately and measure query plans.
- Reach for JSONB only when the data truly fits it.
- Use transactions and constraints to protect integrity.` },

  // Auth / Payments
  { id: 'better-auth', name: 'Better Auth', tags: ['auth', 'authentication', 'login', 'session', 'oauth'], description: 'Better Auth integration best practices.', url: 'https://officialskills.sh/better-auth/skills/best-practices' },
  { id: 'better-auth-providers', name: 'Auth Providers', tags: ['auth', 'oauth', 'google', 'github', 'providers'], description: 'OAuth provider setup.', url: 'https://officialskills.sh/better-auth/skills/providers' },
  { id: 'stripe', name: 'Stripe Best Practices', tags: ['stripe', 'payments', 'checkout', 'subscriptions', 'billing'], description: 'Stripe integration best practices.', url: 'https://officialskills.sh/stripe/skills/stripe-best-practices' },

  // Mobile
  { id: 'callstack-rn', name: 'React Native Best Practices', tags: ['react-native', 'mobile', 'ios', 'android', 'expo'], description: 'React Native performance and best practices.', url: 'https://officialskills.sh/callstackincubator/skills/react-native-best-practices' },
  { id: 'expo-ui', name: 'Expo Native UI', tags: ['expo', 'react-native', 'mobile', 'ui'], description: 'Building native UI in Expo.', url: 'https://officialskills.sh/expo/skills/building-native-ui' },
  { id: 'expo-deploy', name: 'Expo Deployment', tags: ['expo', 'mobile', 'deploy', 'eject'], description: 'Deploying Expo apps.', url: 'https://officialskills.sh/expo/skills/expo-deployment' },

  // Security
  { id: 'tob-secure', name: 'Secure Code Patterns', tags: ['security', 'audit', 'owasp', 'review'], description: 'Secure coding patterns.', url: 'https://officialskills.sh/trailofbits/skills/building-secure-contracts' },
  { id: 'tob-static', name: 'Static Analysis', tags: ['security', 'static-analysis', 'lint'], description: 'Static analysis for security review.', url: 'https://officialskills.sh/trailofbits/skills/static-analysis' },
  { id: 'tob-insecure', name: 'Insecure Defaults', tags: ['security', 'defaults', 'review'], description: 'Common insecure defaults.', url: 'https://officialskills.sh/trailofbits/skills/insecure-defaults' },

  // Testing
  { id: 'testing-tools', name: 'Testing Tools', tags: ['testing', 'test', 'vitest', 'jest', 'playwright', 'cypress', 'mocha', 'unit', 'integration', 'e2e', 'snapshot'], description: 'Unit, integration, and E2E testing patterns.', url: 'https://officialskills.sh/testing/skills/tools', body: `# Testing Best Practices

- Match the tool to the test layer: unit, integration, or E2E.
- Keep tests deterministic and assert specific outcomes.
- Cover edge cases and error paths, not just happy paths.
- Mock boundaries intentionally and keep fixtures small.` },

  // Testing
  { id: 'claude-webapp-test', name: 'Web App Testing', tags: ['playwright', 'e2e', 'testing', 'browser'], description: 'Test local web apps with Playwright.', url: 'https://officialskills.sh/anthropics/skills/webapp-testing' },
  { id: 'tob-pbt', name: 'Property-Based Testing', tags: ['testing', 'property-based', 'fuzz'], description: 'Property-based test patterns.', url: 'https://officialskills.sh/trailofbits/skills/property-based-testing' },

  // Tooling
  { id: 'claude-mcp', name: 'MCP Builder', tags: ['mcp', 'servers', 'api', 'tools'], description: 'Build MCP servers.', url: 'https://officialskills.sh/anthropics/skills/mcp-builder' },
  { id: 'gemini-api', name: 'Gemini API', tags: ['gemini', 'google', 'ai', 'api', 'llm'], description: 'Gemini API best practices.', url: 'https://officialskills.sh/google-gemini/skills/gemini-api-dev' },
  { id: 'openai-deploy', name: 'Deploy OpenAI Apps', tags: ['openai', 'deploy', 'vercel', 'cloudflare', 'netlify'], description: 'Deploy OpenAI-powered apps.', url: 'https://officialskills.sh/openai/skills/deploy' },
  { id: 'tinybird-cli', name: 'Tinybird', tags: ['analytics', 'tinybird', 'clickhouse'], description: 'Tinybird best practices.', url: 'https://officialskills.sh/tinybird/skills/best-practices' },
  { id: 'sentry-sdk', name: 'Sentry SDK', tags: ['sentry', 'monitoring', 'errors'], description: 'Sentry SDK setup.', url: 'https://officialskills.sh/sentry/skills/sentry-react-native-sdk' },

  // HashiCorp
  { id: 'hashi-tf-style', name: 'Terraform Style', tags: ['terraform', 'iac', 'hashicorp'], description: 'Terraform style guide.', url: 'https://officialskills.sh/hashicorp/skills/terraform-style-guide' },
  { id: 'hashi-tf-azure', name: 'Terraform Azure', tags: ['terraform', 'azure', 'iac'], description: 'Azure Verified Modules.', url: 'https://officialskills.sh/hashicorp/skills/azure-verified-modules' },

  // Multi-Language Best Practices & Safety Guidelines
  {
    id: 'python-safety',
    name: 'Python Best Practices & Safe Coding',
    tags: ['python', 'py', 'django', 'flask', 'fastapi', 'pip'],
    description: 'Guidelines to code in Python with zero errors, proper typing, and clean memory/resource management.',
    url: '',
    body: `# Python Best Practices & Error Avoidance
- **Type Hints**: Always use the \`typing\` module or built-in generics (\`list[str]\`, \`dict[str, int]\`). Run type checkers (like \`mypy\`) to catch issues before execution.
- **Mutable Default Arguments**: Never use mutable objects (like lists or dicts) as default parameter values. Use \`None\` as default and assign inside the function body.
- **Resource Management**: Use \`with\` statement contexts for file operations, database transactions, sockets, and lock acquisitions to guarantee correct resource cleanup.
- **Exception Gating**: Write specific catch clauses (\`except ValueError:\` rather than a blank \`except:\`). Always log or handle captured exceptions; never pass them silently unless explicitly documented.`
  },
  {
    id: 'java-safety',
    name: 'Java Best Practices & Error Avoidance',
    tags: ['java', 'spring', 'springboot', 'maven', 'gradle', 'junit'],
    description: 'Guidelines to code in Java with strict type safety, null checking, and robust concurrent operations.',
    url: '',
    body: `# Java Best Practices & Error Avoidance
- **Null Safety**: Avoid returning or passing null. Use Java 8+ \`Optional<T>\` to express optional values, and use static analysis tools like \`@NonNull\` or \`@Nullable\` annotations.
- **Try-With-Resources**: Always use \`try-with-resources\` for auto-closeable interfaces (streams, sockets, database statements) to prevent native file handle leaks.
- **Generic Types**: Always specify generic type parameters (\`List<String>\` instead of raw \`List\`) to preserve compile-time safety.
- **Thread Safety**: Never mutate state concurrently without proper synchronization. Prefer standard concurrent abstractions (\`ConcurrentHashMap\`, \`AtomicInteger\`, \`ExecutorService\`) over manual lock management.`
  },
  {
    id: 'c-cpp-safety',
    name: 'C & C++ Best Practices & Safe Coding',
    tags: ['c', 'cpp', 'c++', 'h', 'hpp', 'gcc', 'g++', 'clang', 'make'],
    description: 'Guidelines to code in C/C++ safely without buffer overflows, memory leaks, or dangling pointers.',
    url: '',
    body: `# C & C++ Best Practices & Error Avoidance
- **Memory Safety**: Avoid raw pointers and manual memory allocation (\`malloc\`, \`free\`, \`new\`, \`delete\`) in modern C++. Use smart pointers (\`std::unique_ptr\`, \`std::shared_ptr\`) and resource containers (\`std::vector\`, \`std::string\`) to handle lifecycle (RAII).
- **Boundary Checks**: Always ensure arrays and pointers are accessed within valid ranges. Prefer \`std::vector::at()\` which performs bounds checking over operator \`[]\` when performance is not critical.
- **Initialization**: Always initialize variables at declaration. Uninitialized variables lead to undefined behaviors and difficult-to-track bugs.
- **Compiler Warnings**: Compile with high warning levels (\`-Wall -Wextra -Werror\`) and fix every warning before running code.`
  },
  {
    id: 'rust-safety',
    name: 'Rust Best Practices & Error Avoidance',
    tags: ['rust', 'rs', 'cargo', 'rustc'],
    description: 'Guidelines to write idiomatic and correct Rust code without unwrap panics or lifetime errors.',
    url: '',
    body: `# Rust Best Practices & Error Avoidance
- **Borrow Checker Rules**: Follow ownership and borrow semantics carefully. Do not attempt to hold mutable reference to an object while sharing immutable references.
- **Robust Error Handling**: Avoid calling \`.unwrap()\` or \`.expect()\` on \`Option\` or \`Result\`. Propagate errors using the \`?\` operator, or handle them explicitly with \`match\` or \`if let\`.
- **Clippy Warnings**: Regularly run \`cargo clippy\` and address all suggestions to maintain standard coding formatting and avoid subtle logic issues.`
  },
  {
    id: 'go-safety',
    name: 'Go Best Practices & Error Avoidance',
    tags: ['go', 'golang'],
    description: 'Guidelines to code in Go with explicit error checking, goroutine safety, and clean API design.',
    url: '',
    body: `# Go Best Practices & Error Avoidance
- **Explicit Error Checks**: Never ignore returned errors. Always check \`if err != nil\` and return/handle it immediately.
- **Goroutine Leaks**: Always ensure spawned goroutines terminate. Use \`context.Context\` or exit channels to cancel asynchronous tasks when they are no longer needed.
- **Race Condition Prevention**: Run tests with \`-race\` flag to detect concurrent read/write issues. Use channels or mutexes (\`sync.Mutex\`) to protect shared states.`
  }
];

for (const skill of TOP_SKILLS) {
  SKILL_INDEX.set(skill.id, skill);
}

/** Returns a curated skill by its exact id, if it exists in the local catalog. */
export function findSkillById(id: string): SkillEntry | undefined {
  return SKILL_INDEX.get(id);
}

/**
 * Returns the top N skills whose tags best match the query, ranked by
 * tag-overlap count. Returns at most `limit` entries.
 */
export function retrieveSkills(query: string, limit = 4): SkillEntry[] {
  const q = normalizeSkillText(query);
  const tokens = q.split(/\s+/).filter(t => t.length > 2);
  if (tokens.length === 0) return [];

  const scored: { skill: SkillEntry; score: number }[] = [];
  for (const skill of TOP_SKILLS) {
    let score = 0;
    const idText = normalizeSkillText(skill.id);
    const nameText = normalizeSkillText(skill.name);
    const descriptionText = normalizeSkillText(skill.description);

    if (q.includes(idText)) score += 4;
    if (q.includes(nameText)) score += 3;
    if (descriptionText && tokens.some(t => descriptionText.includes(t))) score += 1;

    for (const tag of skill.tags) {
      const normalizedTag = normalizeSkillText(tag);
      if (q.includes(normalizedTag)) score += 2;
      for (const t of tokens) {
        if (normalizedTag === t || normalizedTag.includes(t) || t.includes(normalizedTag)) score += 1;
      }
    }
    if (score > 0) scored.push({ skill, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.skill);
}

/**
 * Renders a matched skill set as an inject-able system-prompt block.
 * When a skill has inline `body` content, it is embedded directly.
 * Otherwise the LLM is told to fetch the URL.
 */
export function renderSkillsBlock(skills: SkillEntry[]): string {
  if (skills.length === 0) return '';
  const lines: string[] = ['## Retrieved Expert Skills (apply these patterns)', ''];
  for (const s of skills) {
    lines.push(`- **${s.name}** (\`${s.id}\`) — ${s.description}`);
  }
  lines.push('');

  // Embed inline bodies for skills that have them
  const withBodies = skills.filter(s => s.body);
  if (withBodies.length > 0) {
    lines.push('### Skill Content (pre-loaded — do NOT fetch, already provided)', '');
    for (const s of withBodies) {
      lines.push(`#### ${s.name}`);
      lines.push(s.body!);
      lines.push('');
    }
  }

  // For skills without inline bodies, instruct the LLM to fetch them
  const withoutBodies = skills.filter(s => !s.body);
  if (withoutBodies.length > 0) {
    lines.push('### Skills to Fetch');
    for (const s of withoutBodies) {
      lines.push(`- \`${s.id}\`: ${s.url}`);
    }
    lines.push('');
    lines.push('If you need guidance from the above skills, use `fetch_webpage` to load them before writing code.');
  }

  return lines.join('\n');
}
