# Contributing to reliability-kit

Thank you for your interest in contributing. This document explains how to get started, what we're looking for, and how to get your changes merged.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [What We're Looking For](#what-were-looking-for)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Commit Convention](#commit-convention)
- [Code Standards](#code-standards)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)
- [Questions](#questions)

---

## Getting Started

**Prerequisites:**

- Node.js 18 or above
- npm 9 or above
- Git

**Fork and clone:**

```bash
# fork the repo on GitHub, then clone your fork
git clone git@github.com:YOUR_USERNAME/reliability-kit.git
cd reliability-kit

# install dependencies
npm install

# verify everything works
npm run build:ci
npm test
```

---

## Project Structure

```
reliability-kit/
├── src/
│   ├── core/
│   │   ├── context.ts              # RequestContext interface
│   │   ├── engine.ts               # ReliabilityEngine — middleware chain
│   │   └── module.ts               # ReliabilityModule interface
│   ├── frameworks/
│   │   └── express.ts              # Express adapter
│   ├── middleware/
│   │   ├── reliability.ts          # Public entry point
│   │   └── validation.ts           # Startup validation
│   ├── modules/
│   │   └── idempotency/
│   │       ├── idempotency.ts      # IdempotencyModule
│   │       └── stores/
│   │           ├── store.ts        # IdempotencyStore interface
│   │           ├── memory-store.ts
│   │           └── redis-store.ts
│   ├── types/
│   │   ├── framework.ts            # Framework enum
│   │   └── options.ts              # ReliabilityOptions
│   ├── tests/
│   │   ├── unit/
│   │   │   ├── idempotency.test.ts
│   │   │   ├── memory-store.test.ts
│   │   │   └── redis-store.test.ts
│   │   └── integration/
│   │       ├── express-adapter.test.ts
│   │       └── concurrency.test.ts
│   └── index.ts                    # Public exports
├── docs/
│   └── idempotency.md
├── tsup.config.ts
├── tsconfig.json
└── package.json
```

---

## Development Workflow

```bash
# run all tests
npm test

# run tests in watch mode during development
npm run test:watch

# run only unit tests
npm run test:unit

# run only integration tests
npm run test:integration

# check coverage — must stay above thresholds
npm run test:coverage

# type check without emitting
npm run typecheck

# lint
npm run lint

# format
npm run format

# full CI check — run this before opening a PR
npm run build:ci
```

---

## What We're Looking For

### High priority contributions

- **Framework adapters** — Fastify and Hono adapters are the most requested. See `src/frameworks/express.ts` for the pattern to follow. An adapter must bridge the framework's req/res model to `RequestContext` without any framework-specific code leaking into the core engine.

- **New reliability modules** — Rate limiting, circuit breaker, retry with backoff. A module implements the `ReliabilityModule` interface — one `execute(ctx, next)` method. See `src/modules/idempotency/idempotency.ts` for a complete example.

- **Store reference implementations** — Working examples for Postgres, MySQL, DynamoDB, or MongoDB. These live in `docs/` as reference examples rather than shipped code — we don't own the user's schema, so we document the pattern rather than shipping the implementation.

- **Bug fixes** — Especially anything related to concurrency, TTL handling, or incorrect 409 responses.

### Lower priority

- Dependency additions — we are zero-dependency by design. Any PR that adds a runtime dependency needs a strong justification.
- Breaking changes to public interfaces — discuss in an issue first.
- Cosmetic changes — reformatting or renaming without functional change.

---

## Submitting a Pull Request

1. **Open an issue first** for anything non-trivial. Discuss the approach before writing code — this avoids wasted effort if the direction isn't right.

2. **Branch from the latest `main`:**

   ```bash
   git checkout main
   git pull origin main
   git checkout -b feat/fastify-adapter
   ```

   > Direct pushes to `main` are blocked — all changes must go through a PR.

3. **Write tests first.** We maintain 90%+ branch coverage and 95%+ line coverage. PRs that drop coverage below the thresholds will not be merged. Run `npm run test:coverage` to check before opening the PR.

4. **Follow the code standards** — see below.

5. **Run the full CI check locally before pushing:**

   ```bash
   npm run build:ci && npm test
   ```

6. **Open the PR** against `main` with:
   - A clear title following the commit convention below
   - A description of what changed and why
   - Any relevant issue numbers (`Closes #123`)

7. **Keep PRs focused.** One feature or fix per PR. Large PRs are harder to review and slower to merge.

---

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org):

```
<type>: <short description>

[optional body]

[optional footer]
```

**Types:**

| Type       | Use for                                 |
| ---------- | --------------------------------------- |
| `feat`     | New feature or capability               |
| `fix`      | Bug fix                                 |
| `docs`     | Documentation only                      |
| `test`     | Adding or updating tests                |
| `refactor` | Code change that isn't a fix or feature |
| `chore`    | Build process, dependencies, tooling    |
| `perf`     | Performance improvement                 |

**Examples:**

```
feat: add Fastify adapter
fix: release() not called when acquire() times out
docs: add DynamoDB store example to idempotency docs
test: add concurrency stress tests for MemoryStore
chore: upgrade tsup to v9
```

---

## Code Standards

**TypeScript:**

- No `any` in source files — use `unknown` for values with unknown shape
- All public interfaces and methods must have JSDoc comments
- Exported types must be documented with usage examples where non-obvious

**Tests:**

- Every new feature needs unit tests
- Every bug fix needs a regression test that fails before the fix and passes after
- Use `makeStore()`, `makeCtx()`, and `makeModule()` helpers for consistency
- Mock only what you need — prefer real implementations where practical
- Concurrency-sensitive code needs stress tests — see `concurrency.test.ts` for the pattern

**Comments:**

- Comments explain **why**, not **what** — the code already says what
- Document tradeoffs explicitly, especially around concurrency and atomicity
- Mark critical invariants with `// ⚠️ CRITICAL:` so they don't get accidentally removed

**Store implementations:**

- Must implement the `IdempotencyStore` interface
- Must include JSDoc on every method explaining the atomicity guarantee
- Must handle corrupted data gracefully — never throw on bad stored values
- `release()` must never wipe a completed record — only delete if `status === 'processing'`

---

## Reporting Bugs

Open a GitHub issue with:

- **What happened** — exact error message or incorrect behaviour
- **What you expected** — what should have happened
- **Reproduction** — minimal code that demonstrates the issue
- **Environment** — Node.js version, framework version, store type (Redis, Memory, custom)

For concurrency bugs, include whether you're running multiple instances and what store you're using — most concurrency issues are store-specific.

---

## Requesting Features

Open a GitHub issue with:

- **The problem you're solving** — not the solution, the problem
- **Who else would benefit** — is this a niche use case or broadly applicable?
- **Are you willing to implement it?** — feature requests with an offer to implement are fast-tracked

---

## Questions

Open a [GitHub Discussion](../../discussions) for questions that aren't bugs or feature requests. Answering in Discussions keeps the answer searchable for others who hit the same question.
