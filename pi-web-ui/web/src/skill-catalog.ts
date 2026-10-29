/**
 * 公开 Skill (智能体专项技能) 市场清单
 *
 * 遵循 Agent Skills 规范（SKILL.md + YAML frontmatter）。
 * 支持一键安装到全局 (~/.pi/agent/skills) 或当前项目 (.pi/skills)。
 */

export interface PublicSkill {
	id: string;
	name: string;
	nameZh: string;
	description: string;
	descriptionZh: string;
	category: "quality" | "workflow" | "devops" | "architecture" | "stack";
	content: string;
}

export const PUBLIC_SKILLS: PublicSkill[] = [
	{
		id: "code-review",
		name: "Code Review",
		nameZh: "代码审查与质量把关",
		description:
			"Comprehensive code review guidelines for security vulnerabilities, logic bugs, concurrency flaws, and boundary conditions.",
		descriptionZh: "全方位代码审查：深度排查安全漏洞、并发竞争隐患、边界异常以及性能退化。",
		category: "quality",
		content: `---
name: code-review
description: Comprehensive code review guidelines for security vulnerabilities, logic bugs, concurrency flaws, and boundary conditions. Use when reviewing code changes, pull requests, or diffs.
---

# Code Review Specialist

When reviewing code diffs or pull requests, evaluate the changes across the following dimensions:

## 1. Correctness & Edge Cases
- Check for off-by-one errors, null/undefined dereferences, and uncaught rejections.
- Verify boundary conditions: empty collections, maximum integer sizes, malformed input formats.
- Ensure proper error propagation and resource cleanup (file descriptors, sockets, timers).

## 2. Security & Data Validation
- Validate all untrusted input (SQL injection, path traversal, command injection, XSS).
- Ensure sensitive data (credentials, tokens, PII) is never logged or exposed to clients.
- Verify authorization checks on modified API endpoints.

## 3. Concurrency & Performance
- Watch out for race conditions, deadlock hazards, and uncoordinated state mutation.
- Avoid accidental O(N^2) loops, redundant database roundtrips, or missing memoization.
- Check memory overhead: unbounded buffers, event listener leaks, lingering cache maps.

## 4. Maintainability & Architecture
- Does the change violate Single Responsibility or create unnecessary tight coupling?
- Are functions and variables named with clear semantics?
- Are non-obvious algorithms and domain business rules documented?

Output findings sorted by severity (Critical > Warning > Suggestion) with exact file/line references and concrete code fixes.
`,
	},
	{
		id: "git-commit",
		name: "Git Commit & PR Guide",
		nameZh: "规范化 Git 提交与 PR",
		description:
			"Follows Conventional Commits standards to craft clean, atomic, descriptive git commit messages and PR summaries.",
		descriptionZh: "遵循 Conventional Commits 规范，编写清晰、原子化且具解释力的语义化提交信息与 PR 说明。",
		category: "workflow",
		content: `---
name: git-commit
description: Follows Conventional Commits standards to craft clean, atomic, descriptive git commit messages and PR summaries. Use when committing code, drafting PRs, or summarizing git diffs.
---

# Git Commit & Pull Request Crafting

Follow these rules when generating commit messages and pull request descriptions:

## Conventional Commit Structure
Format: \`<type>(<optional-scope>): <short imperative description>\`

Allowed Types:
- \`feat\`: A new feature for the user
- \`fix\`: A bug fix
- \`refactor\`: Code change that neither fixes a bug nor adds a feature
- \`perf\`: Code change that improves performance
- \`test\`: Adding missing tests or correcting existing tests
- \`docs\`: Documentation only changes
- \`style\`: Formatting, white-space, missing semi-colons (no code change)
- \`chore\`: Build process, package manager, or tooling updates

## Guidelines
1. Use imperative mood in the subject line (e.g. "add support for...", not "added" or "adds").
2. Do not capitalize the first letter of the subject line, and do not end with a period.
3. Keep the first line strictly under 72 characters.
4. If there is a body, separate it with a blank line and explain **why** the change was made, not just what was changed.
5. If there are breaking changes, add \`BREAKING CHANGE:\` in the footer.
`,
	},
	{
		id: "unit-testing",
		name: "Unit Test Generator",
		nameZh: "完备单元测试设计",
		description:
			"Design comprehensive, readable unit and integration tests with happy paths, edge cases, error branches, and proper mocks.",
		descriptionZh: "自动设计高覆盖度、结构清晰的单元与集成测试：覆盖正常流程、边界条件、异常分支与合理 Mock。",
		category: "quality",
		content: `---
name: unit-testing
description: Design comprehensive, readable unit and integration tests with happy paths, edge cases, error branches, and proper mocks. Use when writing tests or boosting test coverage.
---

# Unit Test Design Principles

When designing unit tests for functions, modules, or services:

## 1. Arrange-Act-Assert (AAA) Pattern
Structure every test case clearly:
- **Arrange**: Set up inputs, mocks, and initial state.
- **Act**: Invoke the target function or unit under test.
- **Assert**: Verify output values, state changes, and mock call expectations.

## 2. Test Coverage Matrix
Always include:
- **Happy Path**: Standard valid inputs with expected outputs.
- **Boundary Conditions**: Zero, empty arrays, null/undefined, maximum allowable values, Unicode strings.
- **Error Branches**: Invalid arguments, network drops, permission rejections, timeout failures.
- **Idempotency**: Running the operation twice yields consistent state without unintended duplication.

## 3. Mocking Best Practices
- Mock external side effects (file system, network requests, databases, timers).
- Do not over-mock internal implementation details; assert on observable public behavior.
- Ensure all mocks are reset or restored after each test to avoid cross-test contamination.
`,
	},
	{
		id: "web-performance",
		name: "Web Performance Profiler",
		nameZh: "前端性能与渲染优化",
		description:
			"Diagnose frontend rendering bottlenecks, redundant re-renders, bundle size inflation, and Core Web Vitals issues.",
		descriptionZh: "诊断前端渲染瓶颈、组件多余重绘、打包体积膨胀、首屏加载慢与 Core Web Vitals 核心指标优化。",
		category: "stack",
		content: `---
name: web-performance
description: Diagnose frontend rendering bottlenecks, redundant re-renders, bundle size inflation, and Core Web Vitals issues. Use when profiling or optimizing web apps.
---

# Web Performance & Frontend Optimization

Focus on these areas when optimizing web frontend applications:

## 1. Component Rendering & React/DOM
- Identify unnecessary re-renders using \`useMemo\`, \`useCallback\`, or component extraction.
- Verify list rendering: ensure stable unique keys (never use index for dynamic lists).
- Virtualize large lists or tables with 100+ items (e.g. virtual scrolling).
- Avoid layout thrashing: batch DOM measurements and style updates together.

## 2. Bundle Size & Code Splitting
- Split routes and large modals with dynamic \`import()\`.
- Inspect large dependencies and prefer tree-shakeable modern alternatives (e.g. date-fns or native Temporal over moment).
- Eliminate duplicate packages and duplicate polyfills.

## 3. Core Web Vitals
- **LCP (Largest Contentful Paint)**: Prioritize critical images, preload fonts, inline critical CSS.
- **INP (Interaction to Next Paint)**: Break long tasks into microtasks with \`scheduler.yield()\` or \`setTimeout\`.
- **CLS (Cumulative Layout Shift)**: Always set explicit \`width\` and \`height\` on images/embeds.
`,
	},
	{
		id: "security-audit",
		name: "Security Audit & Vulnerabilities",
		nameZh: "安全审计与漏洞排查",
		description:
			"Audit codebases against OWASP Top 10 vulnerabilities, unauthorized access, injection flaws, and insecure dependencies.",
		descriptionZh: "依据 OWASP Top 10 安全标准审计代码：防御 SQL/命令注入、未授权越权、反序列化攻击及敏感信息泄露。",
		category: "quality",
		content: `---
name: security-audit
description: Audit codebases against OWASP Top 10 vulnerabilities, unauthorized access, injection flaws, and insecure dependencies. Use when reviewing security aspects.
---

# Security Code Audit

Review code systematically for vulnerability patterns:

## 1. Injection & Deserialization
- **Command Injection**: Ensure process spawns pass arguments as array lists, never concatenated shell strings.
- **SQL / NoSQL Injection**: Require parameterized queries or prepared statements without raw string interpolation.
- **Path Traversal**: Validate and canonicalize all file paths using \`path.resolve\` and assert they remain within the allowed root.

## 2. Authentication & Authorization
- Verify that every non-public route performs explicit authentication and role checks.
- Prevent IDOR (Insecure Direct Object Reference): check that the authenticated user owns the requested entity ID.
- Timing-safe comparisons: use constant-time comparison functions for hashes and tokens.

## 3. Secrets & Configuration
- Never hardcode API keys, certificates, or JWT secrets in repository code.
- Ensure debug modes, stack traces, and verbose error messages are suppressed in production.
- Sanitize user content against Cross-Site Scripting (XSS) before rendering in HTML.
`,
	},
	{
		id: "doc-generator",
		name: "Technical Documentation",
		nameZh: "技术文档与 API 规范生成",
		description:
			"Extract architectural intent and generate clear, accurate technical documentation, API specifications, and README guides.",
		descriptionZh: "精准提炼代码架构与接口语义，生成清晰专业的技术文档、REST/RPC 接口规范与部署快速上手手册。",
		category: "workflow",
		content: `---
name: doc-generator
description: Extract architectural intent and generate clear, accurate technical documentation, API specifications, and README guides. Use when documenting APIs, modules, or projects.
---

# Technical Documentation Guidelines

When documenting codebases, libraries, or APIs:

## 1. Structure & Clarity
- Start with a single-sentence overview of the module's core responsibility.
- Provide a quick start example showing the most common usage pattern first.
- Clearly state prerequisites, supported platforms, and configuration environment variables.

## 2. API Specification Format
For each exported function, endpoint, or class:
- **Signature**: Exact TypeScript types or endpoint HTTP method + URL.
- **Parameters**: Table detailing name, type, required status, and description.
- **Return Value**: Detailed schema of success responses.
- **Error Conditions**: Specific error codes, HTTP statuses, and when they are thrown.

## 3. Tone & Style
- Write concisely in active voice.
- Explain "why" design decisions were made, not just "what" the code does.
- Include diagrams (ASCII or Mermaid) for non-trivial state machines or request data flows.
`,
	},
	{
		id: "refactoring",
		name: "Refactoring Specialist",
		nameZh: "代码重构与坏味道治理",
		description:
			"Identify code smells, apply SOLID principles, decompose monolithic functions, and improve structural cohesion safely.",
		descriptionZh: "精准识别代码坏味道，运用 SOLID 原则治理超长函数、上帝类与深层嵌套，保证行为等价的同时提升内聚。",
		category: "architecture",
		content: `---
name: refactoring
description: Identify code smells, apply SOLID principles, decompose monolithic functions, and improve structural cohesion safely. Use when improving code structure without changing behavior.
---

# Code Refactoring Principles

When refactoring code without altering external behavior:

## 1. Smells to Eliminate
- **Long Method / Large Class**: Split into small, single-purpose functions and focused classes.
- **Deep Nesting**: Use guard clauses and early returns to flatten indentation.
- **Feature Envy**: Move methods closer to the data they primarily operate on.
- **Primitive Obsession**: Encapsulate related fields into domain objects or strong types.

## 2. Safety First
- Verify that unit tests pass before making any structural modifications.
- Perform small, incremental transformations instead of massive rewrites.
- Separate refactoring commits from feature and bugfix commits.

## 3. Clean Code Patterns
- Prefer composition over inheritance.
- Replace complex boolean flags with explicit strategy patterns or polymorphism.
- Make implicit dependencies explicit via dependency injection.
`,
	},
	{
		id: "api-design",
		name: "API Design & Standards",
		nameZh: "RESTful / RPC 接口设计规范",
		description:
			"Design uniform, versioned, developer-friendly REST and RPC APIs with consistent error schemas and pagination.",
		descriptionZh: "规范化设计 RESTful 与 RPC 接口：统一资源路径命名、幂等性语义、结构化错误码与游标分页机制。",
		category: "architecture",
		content: `---
name: api-design
description: Design uniform, versioned, developer-friendly REST and RPC APIs with consistent error schemas and pagination. Use when creating or refining API endpoints.
---

# API Design Standards

Apply these conventions when designing HTTP/RESTful APIs:

## 1. URI & Resource Naming
- Use plural nouns for resources (e.g. \`/api/v1/users\`, \`/api/v1/projects\`).
- Use sub-resources for nested hierarchies (e.g. \`/api/v1/projects/:id/members\`).
- Use query parameters for filtering, sorting, and pagination (never in path segments).

## 2. HTTP Verbs & Idempotency
- \`GET\`: Safe and idempotent read operations.
- \`POST\`: Resource creation or non-idempotent operations.
- \`PUT\`: Complete replacement (idempotent).
- \`PATCH\`: Partial update (idempotent when RFC 6902 or merge patch is applied).
- \`DELETE\`: Resource removal (idempotent).

## 3. Error Responses
Always return a consistent JSON envelope for errors:
\`\`\`json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Project with id 123 was not found",
    "details": []
  }
}
\`\`\`
`,
	},
	{
		id: "docker-expert",
		name: "Docker & Containerization",
		nameZh: "Docker 与轻量容器化部署",
		description:
			"Write lean, multi-stage Dockerfiles, minimize image layers, enforce non-root security, and create compose setups.",
		descriptionZh:
			"编写轻量安全的多阶段 Dockerfile、精简镜像层级、强制非 root 用户运行，并构建标准的 Docker Compose 编排。",
		category: "devops",
		content: `---
name: docker-expert
description: Write lean, multi-stage Dockerfiles, minimize image layers, enforce non-root security, and create compose setups. Use when containerizing applications or building Dockerfiles.
---

# Dockerfile & Container Best Practices

Follow these rules when containerizing services:

## 1. Multi-Stage Builds
- Separate builder stages (with SDKs, compilers, headers) from runner stages (minimal distroless or alpine runtime).
- Copy only compiled artifacts and production dependencies to the final stage.

## 2. Caching & Layer Optimization
- Copy dependency definition files (\`package.json\`, \`requirements.txt\`, \`go.mod\`) before source files to maximize layer cache hits.
- Combine consecutive \`RUN apt-get update && apt-get install && rm -rf /var/lib/apt/lists/*\` to keep images small.

## 3. Security
- Never run containers as \`root\`: create and switch to a dedicated unprivileged user (\`USER node\` or \`USER appuser\`).
- Never embed build arguments containing secrets into image layers.
- Implement explicit health checks (\`HEALTHCHECK\`).
`,
	},
	{
		id: "sql-optimizer",
		name: "SQL & Index Optimization",
		nameZh: "SQL 与数据库索引优化",
		description:
			"Analyze slow queries, optimize execution plans, design composite indexes, and avoid N+1 query patterns.",
		descriptionZh: "分析慢查询与执行计划，设计精准复合索引，治理全表扫描与 N+1 级联查询，保障高并发下的数据吞吐。",
		category: "devops",
		content: `---
name: sql-optimizer
description: Analyze slow queries, optimize execution plans, design composite indexes, and avoid N+1 query patterns. Use when analyzing database performance or tuning SQL.
---

# SQL & Database Tuning

Guidelines for database query and schema optimization:

## 1. Index Strategy
- Understand Leftmost Prefix Rule for composite indexes \`(A, B, C)\`.
- Place equality columns first, followed by range/sort columns.
- Avoid indexing low-cardinality columns (e.g. booleans) unless used in a selective partial index.

## 2. Query Anti-Patterns
- Never use \`SELECT *\` in production; select only required columns to enable index-only covering scans.
- Avoid leading wildcards in \`LIKE '%abc'\` which force full table scans.
- Watch out for functions on indexed columns (e.g. \`WHERE DATE(created_at) = ...\`) which invalidate indexes.

## 3. Batching & Concurrency
- Use cursor-based pagination (\`WHERE id > :last_id LIMIT 50\`) instead of high-offset \`OFFSET 10000\`.
- Keep transaction durations minimal to prevent row-lock escalation.
`,
	},
	{
		id: "strict-typescript",
		name: "Strict TypeScript Patterns",
		nameZh: "TypeScript 严格类型强化",
		description:
			"Eliminate 'any', build precise discriminated unions, leverage template literal types, and enforce sound generics.",
		descriptionZh:
			"消除 any 与盲目类型断言，运用可辨识联合类型、模板字面量类型、精细泛型约束与类型守卫提升代码健壮度。",
		category: "stack",
		content: `---
name: strict-typescript
description: Eliminate 'any', build precise discriminated unions, leverage template literal types, and enforce sound generics. Use when refining TypeScript types or writing robust libraries.
---

# Strict TypeScript Patterns

Enforce strong, expressive type safety:

## 1. Eliminate 'any'
- Prefer \`unknown\` over \`any\` for unvalidated external data, paired with type guards or schema validators.
- Use \`never\` in exhaustive switch checks to ensure all cases of a union are handled at compile time.

## 2. Discriminated Unions
- Model state with a common discriminator field (e.g. \`type: 'loading' | 'success' | 'error'\`).
- Let TypeScript narrow properties automatically in branches without manual casting.

## 3. Utility Types & Immutability
- Use \`readonly\` and \`ReadonlyArray<T>\` to prevent unintentional in-place state mutations.
- Prefer explicit return types on public library functions to prevent accidental breaking changes across builds.
`,
	},
	{
		id: "bug-triaging",
		name: "Bug Triaging & Root Cause Analysis",
		nameZh: "故障定位与根因分析",
		description:
			"Trace errors from stack traces and logs back to root causes, formulate minimal reproductions, and devise regression-proof fixes.",
		descriptionZh: "从异常日志与堆栈跟踪中逆向推导故障根本原因，构造最小可复现步骤并设计杜绝二次回归的根治方案。",
		category: "quality",
		content: `---
name: bug-triaging
description: Trace errors from stack traces and logs back to root causes, formulate minimal reproductions, and devise regression-proof fixes. Use when diagnosing bugs or fixing tricky errors.
---

# Bug Triaging & Root Cause Analysis

Systematic steps for investigating and resolving software defects:

## 1. Information Gathering
- Identify the exact environment, runtime version, commit hash, and input triggers.
- Analyze the stack trace from bottom to top to identify where internal invariants were violated.
- Check recent commits touching the affected code path to pinpoint regressions.

## 2. Hypothesis & Reproduction
- Create a minimal, self-contained reproduction case (unit test or script).
- Formulate a testable hypothesis explaining why the error occurred under specific conditions.
- Test the boundaries: does the bug trigger with different data shapes, concurrency levels, or permissions?

## 3. Defect Remediation
- Fix the root cause, not merely the symptom (avoid simply wrapping in try/catch or adding null checks without understanding why the value was null).
- Add automated regression tests that fail before the fix and pass after.
`,
	},
];
