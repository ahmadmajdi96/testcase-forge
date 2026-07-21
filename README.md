# TestCase Forge

A production-oriented microservice that ingests specification/QA-plan documents and
generates **detailed, Playwright-ready test cases** using **Novita AI**. Each generated
case has two halves:

- a **UI view** that maps 1:1 to the *Create Test Case* screen (Title, Description,
  Preconditions, Expected Result, numbered Test Steps, Status, Priority, Coverage Tags), and
- a **hidden AI context** (routes, locators, network mocks, fixtures, assertions,
  Playwright hints, traceability, evidence gaps) that is *not* rendered in the app but is
  sent to a downstream code-generation model to produce runnable Playwright specs.

The service guarantees **coverage of every extracted detail**: it atomises the uploaded
documents into addressable coverage items, requires every item id to be claimed by a
generated case, and runs a **coverage-repair loop** for anything missed. A machine-checkable
coverage report is attached to every job.

---

## Why it is built this way

| Concern | Approach |
|---|---|
| Cover *every* detail | Documents are parsed into atomic `CoverageItem`s (endpoints, routes, selectors, env vars, personas, fixtures, mocks, risks, requirements). Each item must appear in some case's `coveredItemIds`. Two repair layers close gaps: a **per-unit** loop re-asks within a unit, and a **job-level** loop re-plans any globally-uncovered items (including those from units that timed out and were skipped). A coverage report proves closure. |
| Two-tier output | `TestCaseUi` = exactly the app fields. `TestCaseAi` = machine context for the code generator. `GET .../test-cases?view=ui` returns only UI fields; the default view returns both. |
| Scalable | Stateless HTTP layer, concurrency-limited generation pool, per-unit work partitioning, pluggable `JobStore` (in-memory now, swap for Redis/Postgres). Horizontal scaling ready. |
| Maintainable | Small single-purpose modules, strict TypeScript, Zod validation at every boundary, 30+ tests. |
| Resilient to a real LLM | Timeouts, retries with jittered backoff, circuit breaker, **automatic `json_schema` → `json_object` fallback**, truncated-array salvage, and **per-unit fault isolation** (one bad unit never fails the whole job). |
| Safe | API-key auth, per-file/total upload limits, binary rejection, path-separator stripping, secret redaction in logs, Helmet, rate limiting. |
| Multi-tenant | Every API key belongs to exactly one tenant (`TENANT_API_KEYS=acme:key1,globex:key2`). Jobs, listings, cancellation and artifacts are tenant-isolated; another tenant's job id behaves as 404 (no existence leak). |
| Durable results | Terminal jobs are flushed to `ARTIFACTS_DIR/<tenant>/<jobId>/` (`job.json`, `coverage.json`, `test-cases.full.json`, `test-cases.ui.json`) *before* the job reports terminal status, and served via `/v1/artifacts` — surviving restarts and redeploys (volume-mounted in compose). |

---

## Quick start

```bash
cp .env.example .env          # set NOVITA_API_KEY (and SERVICE_API_KEYS for prod)
npm install
npm run dev                    # http://localhost:8080
```

Real end-to-end smoke test against Novita (no mocks):

```bash
NOVITA_API_KEY=sk_... npm run smoke            # uses /Downloads/jobsss/extracted by default
NOVITA_API_KEY=sk_... npx tsx scripts/live-smoke.ts /path/to/docs
```

Tests:

```bash
npm test          # unit + mocked-integration (no network)
npm run typecheck
```

Export a job's generated test cases to disk (real Novita):

```bash
# artifacts/<jobId>/{job.json, coverage.json, test-cases.full.json, test-cases.ui.json}
NOVITA_API_KEY=sk_... npx tsx scripts/export-job.ts /path/to/docs
NOVITA_API_KEY=sk_... npx tsx scripts/export-job.ts /path/to/docs 02_api,context   # filter by filename
```

Docker Compose (recommended for production):

```bash
# .env — required values
cat > .env <<'EOF'
NOVITA_API_KEY=sk_your_novita_key
TENANT_API_KEYS=acme:sk_acme_key,globex:sk_globex_key
HOST_PORT=8225
EOF

docker compose up -d --build
curl localhost:8225/healthz    # host port defaults to 8225 (override with HOST_PORT)
```

The compose stack runs `NODE_ENV=production` (auth is mandatory), as a non-root user,
with a healthcheck, `restart: unless-stopped`, a memory limit, and a named volume
`artifacts:` mounted at `/data/artifacts` so generated test cases survive restarts.

Plain Docker:

```bash
docker build -t testcase-forge .
docker run -p 8080:8080 -v tcf-artifacts:/data/artifacts \
  -e NOVITA_API_KEY=sk_... -e TENANT_API_KEYS=acme:your-key testcase-forge
```

---

## API

All `/v1/*` routes require `Authorization: Bearer <key>` or `x-api-key: <key>` when
`SERVICE_API_KEYS` is set. Health routes are open.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/test-generations` | Submit documents (multipart *or* JSON). Returns `202` + job. |
| `GET` | `/v1/test-generations` | List recent jobs. |
| `GET` | `/v1/test-generations/:id` | Job status, progress, coverage report, usage. |
| `GET` | `/v1/test-generations/:id/test-cases` | Full cases (UI + hidden AI context). |
| `GET` | `/v1/test-generations/:id/test-cases?view=ui` | UI-only view (exactly the app fields). |
| `POST` | `/v1/test-generations/:id/cancel` | Cancel an in-flight job. |
| `GET` | `/v1/artifacts` | List the tenant's persisted jobs (survive restarts). |
| `GET` | `/v1/artifacts/:jobId/files` | List a persisted job's files. |
| `GET` | `/v1/artifacts/:jobId/files/:file` | Download `job.json`, `coverage.json`, `test-cases.full.json` or `test-cases.ui.json`. |
| `POST` | `/v1/codegen` | **Client-triggered** Playwright code generation from a completed test-generation job (`sourceJobId` + env-var name block + include filters). Never starts automatically. |
| `GET` | `/v1/codegen/:id` | Live status, per-file progress, usage. |
| `GET` | `/v1/codegen/:id/trace` | Full append-only trace: every planning/generation/persistence event with timestamps, tokens, attempts. |
| `GET` | `/v1/codegen/:id/files` / `/files/*` | List/download generated files (config, fixtures, spec files). |
| `GET` | `/v1/codegen/:id/bundle` | Whole suite as one `{path: content}` JSON map. |
| `POST` | `/v1/codegen/:id/cancel` | Cancel an in-flight codegen job. |
| `GET` | `/v1/codegen-artifacts` | Persisted codegen jobs for the tenant (post-restart discovery). |
| `POST` | `/v1/test-runs` | **Client-triggered** suite execution: `codegenJobId` + `baseUrl` + runtime `env` values (memory-only, never persisted/logged). Runs in an isolated Playwright container. |
| `GET` | `/v1/test-runs/:id` | Live status: per-test results, pass/fail counts, exit code. |
| `GET` | `/v1/test-runs/:id/events` | **SSE live view**: replays history then streams `test_started`, `step_finished`, `test_finished`, `run_terminal` events in real time. |
| `GET` | `/v1/test-runs/:id/artifacts` / `/artifacts/*` | List/download run evidence: videos (`.webm`), traces (`.zip`), screenshots (`.png`), logs. |
| `POST` | `/v1/test-runs/:id/cancel` | Kill an in-flight run (container included). |
| `GET` | `/v1/run-artifacts` | Persisted runs for the tenant. |
| `GET` | `/healthz` `/readyz` `/metrics` | Liveness, readiness (pings Novita), Prometheus metrics. |

All jobs and artifacts are scoped to the tenant resolved from the API key.

### Codegen design notes

- **Traceability end to end**: the trace log records every event; each generated
  test carries a header comment with its test-case id, coverage-item ids and the
  source/codegen job ids — a failure in CI maps straight back to the requirement.
- **Deterministic scaffold, generated specs**: `playwright.config.ts`, env plumbing
  and auth fixtures are templated (identical across runs); only spec files come
  from the model. Env variables appear by NAME only — values are runtime-injected.
- **UI language**: `options.uiLocale` (default `en`) is forced into `localStorage`
  before app hydration in `auth.setup.ts`, captured into every saved storage state,
  and applied to no-auth specs via a default anonymous state — so suites run in a
  deterministic language even when the app defaults to another. Override the storage
  key with `options.localeStorageKey` (default `locale`) or at runtime via
  `TEST_LOCALE` / `TEST_LOCALE_KEY`.
- **Scale/fairness**: bounded LLM concurrency (`CODEGEN_CONCURRENCY`), per-tenant
  active-job caps (`MAX_ACTIVE_CODEGEN_PER_TENANT`), per-file fault isolation
  (`completed_with_errors` instead of all-or-nothing), and `include.limit`/filters
  for cost control.

### Submit via JSON

```bash
curl -X POST localhost:8080/v1/test-generations \
  -H 'authorization: Bearer your-key' -H 'content-type: application/json' \
  -d '{
    "files": [
      { "filename": "02_api.md", "content": "# API\n\n## Endpoints\n..." },
      { "filename": "context.json", "content": "{...}", "encoding": "utf8" }
    ],
    "options": { "maxItemsPerUnit": 10, "concurrency": 5, "maxRepairRounds": 2 }
  }'
```

### Submit via multipart

```bash
curl -X POST localhost:8080/v1/test-generations \
  -H 'authorization: Bearer your-key' \
  -F 'files=@02_api_integration_contract_plan.md' \
  -F 'files=@test_generation_context.json' \
  -F 'options={"maxItemsPerUnit":10}'
```

### Example UI-view test case

```json
{
  "id": "TC-de27ea37-0001",
  "title": "Unauthenticated request to protected endpoint returns 401",
  "description": "Verifies POST /api/rag/upload rejects requests without a session...",
  "preconditions": "The system is running. The user is not logged in.",
  "expectedResult": "The API returns 401 with the standard error shape.",
  "status": "Draft",
  "priority": "P0 - Blocker",
  "coverageTags": ["api", "auth", "negative"],
  "steps": [
    { "index": 1, "action": "Send a POST to /api/rag/upload without auth headers.",
      "expectedResult": "Response status is 401." }
  ]
}
```

The same case in the full view additionally carries `ai.selectors`, `ai.assertions`,
`ai.networkMocks`, `ai.playwright`, `ai.traceability`, and `ai.evidenceGaps` — the context
the Playwright code generator consumes.

---

## Configuration

See `.env.example`. Key variables: `NOVITA_API_KEY`, `NOVITA_MODEL` (default
`deepseek/deepseek-v3.2`; `openai/gpt-oss-120b` is a fast alternative — both support the
strict JSON schema; other models auto-fall back to `json_object`), `SERVICE_API_KEYS`,
`MAX_FILE_BYTES`, `MAX_ITEMS_PER_UNIT`, `GENERATION_CONCURRENCY`, `MAX_REPAIR_ROUNDS`.

## Architecture

```
ingest/   extractor → analyzer (coverage items) → planner (generation units)
llm/      novita client (retries/breaker/fallback) · prompt · schema · parse · generator
coverage/ normalize (model output → domain) · report (coverage audit)
jobs/     service (orchestration) · store (TTL) · pool (concurrency) · types
api/      app (fastify) · auth · routes (jobs, health)
```

## Limitations / next steps

- Job state is in-memory; for multi-replica deployments swap `JobStore` for Redis/Postgres
  and move generation onto a durable queue (the interfaces are already isolated).
- Only UTF-8 text documents are supported (md/json/txt/csv/html/yaml/...). PDF/DOCX would
  need a pre-extraction step.
