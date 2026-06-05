# Bun / TypeScript Runner

Primary runner for current benchmark matrices and reports.

## Install

```bash
npm install
```

## Commands

- `bun run bench`: run one provider/mode.
- `bun run matrix`: run several provider/mode combinations concurrently.
- `bun run prewarm`: create or test warm artifacts where supported.
- `bun run report`: generate a raw markdown report from result JSON files.

## Local Smoke

```bash
bun run bench --provider local --task-index 0 --output ../results/ts-local-one.json
```

## Solve-Enabled Provider Run

```bash
bun --env-file=../.env src/bench.ts --provider modal --mode cold --dataset ../data/swesmith_v4_smoke100.jsonl --task-index all --task-limit 20 --concurrency 2 --timeout-seconds 900 --solve-timeout-seconds 300 --forward-env OPENROUTER_API_KEY,OPENROUTER_MODEL,SOLVER_MAX_STEPS,SOLVER_STEP_TIMEOUT_SECONDS --solve-command-file ../scripts/openrouter_solver.sh --output ../results/ts-modal-cold-task20.json
```

## Matrix Run

```bash
bun --env-file=../.env src/matrix.ts --providers all --modes cold,warm --task-index all --task-limit 20 --concurrency 2 --run-concurrency 6 --timeout-seconds 900 --solve-timeout-seconds 300 --solve-command-file ../scripts/openrouter_solver.sh --output ../results/solve-price-matrix-task20.json
```

The matrix runner starts provider/mode runs concurrently. It also applies provider-specific task concurrency caps unless overridden with `--vercel-concurrency`, `--modal-concurrency`, or `--daytona-concurrency`.

## Report Generation

```bash
bun run report --results-dir ../results --output ../reports/generated-provider-report.md
```

Generated reports are raw summaries. Curated analysis lives in `../reports/`.

## Task Runtime Mapping

- `terminalbench` tasks run from `/workspace` on the configured runtime.
- `harbor_swesmith` tasks run from `/testbed`.
- Modal and Daytona can use task Docker images or Dockerfile-derived setup.
- Vercel uses the configured runtime plus fallback setup and repo-specific dependency repair for SWE-Smith tasks.

## Validation

```bash
bun run typecheck
```
