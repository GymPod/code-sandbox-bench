# code-sandbox-bench

Benchmark harness for running code-repair tasks across sandbox providers.

The project currently compares Vercel, Modal, and Daytona on TerminalBench and SWE-Smith style tasks. It records sandbox lifecycle timings, solver/verifier status, output tails, and provider cost estimates so warm and cold runs can be compared with the same task set.

## Repository Layout

- `data/`: bundled TerminalBench and SWE-Smith smoke datasets in parquet and JSONL form.
- `py/`: Python runner and provider adapters.
- `ts/`: Bun/TypeScript runner, matrix runner, prewarm helper, and report generator.
- `results/`: checked-in benchmark artifacts and investigation probes.
- `reports/`: curated markdown analysis split into cross-vendor, per-task, and failure-mode views.
- `scripts/`: dataset extraction and OpenRouter solver helpers.

## Current Findings

Start with [reports/terminalbench_provider_report.md](reports/terminalbench_provider_report.md).

The current apples-to-apples comparison focuses on the 13 tasks from the first 20 SWE-Smith smoke tasks that pass on all three providers in both warm and cold modes. On that subset, Daytona is fastest and lowest estimated provider cost, Modal is next, and Vercel is slowest for this SWE-Smith fallback-runtime workload.

The broader 20-task rollup is still useful, but it mixes provider performance with Docker-image fidelity gaps and real task failures. Details are split across:

- [reports/cross-vendor-comparison.md](reports/cross-vendor-comparison.md)
- [reports/per-task-comparison.md](reports/per-task-comparison.md)
- [reports/per-task-failure-audit.md](reports/per-task-failure-audit.md)
- [reports/per-provider-report.md](reports/per-provider-report.md)
- [reports/failure-modes-tradeoffs.md](reports/failure-modes-tradeoffs.md)

## Task Environment Mapping

The runner normalizes task layout before solving:

env type | workdir | provider runtime mapping
--- | --- | ---
`terminalbench` | `/workspace` | configured runtime.
`harbor_swesmith` | `/testbed` | Modal and Daytona use the task Docker image or Dockerfile-derived setup; Vercel uses a fallback runtime plus repo-specific dependency repair.

SWE-Smith rows include `tests/test.sh`, `solution/*`, and an `environment/Dockerfile` inside the task archive. Vercel cannot consume those per-task Docker images directly in this harness, so exact Docker-image fidelity may require a provider-specific snapshot/runtime.

## Quick Start

Install the TypeScript runner:

```bash
(cd ts && npm install)
```

Run one local task:

```bash
(cd ts && bun run bench --provider local --task-index 0 --output ../results/ts-local-one.json)
```

Run a small Vercel/Modal/Daytona matrix:

```bash
bun --env-file=.env ts/src/matrix.ts --providers all --modes cold,warm --task-index all --task-limit 20 --concurrency 2 --run-concurrency 6 --timeout-seconds 900 --solve-timeout-seconds 300 --solve-command-file scripts/openrouter_solver.sh --output results/solve-price-matrix-task20.json
```

For solver-enabled remote runs, set provider credentials and OpenRouter variables in `.env`. Use `.env.example` as the template when present.

## Result Schema

Each run JSON records:

- provider, mode, runtime, dataset, and task environment counts
- pass count and estimated provider cost
- per-task elapsed seconds and phase timings
- verifier return code plus stdout/stderr tails
- solver return code and output tails when a solver is enabled

Matrix JSON files summarize a group of provider/mode run artifacts.

## Reporting

Curated reports live in `reports/`. To generate a fresh raw provider report from the newest matching artifacts:

```bash
cd ts
bun run report --results-dir ../results --output ../reports/generated-provider-report.md
```

The generated report is intentionally separate from the curated report files.

### How The Reports Were Generated

The curated reports in `reports/` were produced in three steps:

1. **Solve-enabled matrix runs.** `ts/src/matrix.ts` ran cold and warm solve runs for Vercel, Modal, and Daytona over the first 20 tasks of `data/swesmith_v4_smoke100.jsonl`, using `scripts/openrouter_solver.sh` as the solver. Each provider/mode run wrote one result JSON to `results/`; the exact input files behind the current reports are listed in [results/README.md](results/README.md) under "Current Report Inputs".
2. **Raw report generation.** `ts/src/report.ts` (`bun run report`) discovers the newest `ts-<provider>-<mode>-solve-all*.json` per provider/mode in `--results-dir` and computes the rollup, phase, and per-task tables. No numbers in the generated report are hand-written.
3. **Curated analysis.** The cross-vendor, per-task, and failure-mode documents were written from the raw report plus the per-task output tails in the result JSONs, restricting the headline comparison to the 13 tasks that pass on all three providers in both cold and warm modes.

The `Updated:` date in each curated report reflects when the analysis was last revised, not when the benchmark runs executed.

## Provider Notes

- Vercel uses `@vercel/sandbox`. Configure `VERCEL_API_KEY`, `VERCEL_ACCESS_TOKEN`, or `VERCEL_TOKEN`, plus `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` unless OIDC credentials are available.
- Modal uses the Modal SDK credentials supported by `modal`.
- Daytona uses `DAYTONA_API_KEY` and, when needed, `DAYTONA_API_URL` and `DAYTONA_TARGET`.
- Cost estimates are harness estimates from measured wall-clock time and configured provider rates. They exclude OpenRouter model spend.
