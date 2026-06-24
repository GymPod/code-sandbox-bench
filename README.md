# code-sandbox-bench

Benchmark harness for running code-repair tasks across sandbox providers.

The project currently compares Vercel, Modal, Daytona, and AWS Lambda MicroVMs on TerminalBench and SWE-Smith style tasks. It records sandbox lifecycle timings, solver/verifier status, output tails, and provider cost estimates so warm and cold runs can be compared with the same task set.

## Repository Layout

- `data/`: bundled TerminalBench and SWE-Smith smoke datasets in parquet and JSONL form.
- `py/`: Python runner and provider adapters.
- `ts/`: Bun/TypeScript runner, matrix runner, prewarm helper, and report generator.
- `results/`: ignored local benchmark artifacts plus checked-in metadata.
- `reports/`: curated markdown analysis split into cross-vendor, per-task, and failure-mode views.
- `docs/providers/`: provider configuration notes for Vercel, Modal, and Daytona.
- `scripts/`: dataset extraction and OpenRouter solver helpers.

## Current Findings

Start with [reports/terminalbench_provider_report.md](reports/terminalbench_provider_report.md).

The current apples-to-apples runnability comparison covers all 100 tasks in `data/swesmith_v4_smoke100.jsonl`. Vercel, Modal, and Daytona each have 100/100 passing cold-gold evidence.

The timing rollups are stitched from full and focused reruns, so use them for provider head-to-head shape rather than strict synchronized wall-clock claims. Details are split across:

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
`harbor_swesmith` | `/testbed` | Modal and Daytona use the task Docker image or Dockerfile-derived setup; Vercel and local reconstruct the environment from per-repo manifests in `data/swesmith_env_manifests.json` (exact Python via uv, mirror clone, SWE-Smith profile install commands).

[SWE-Smith](https://swesmith.com/) rows include `tests/test.sh`, `solution/*`, and an `environment/Dockerfile` inside the task archive. Vercel cannot consume those per-task Docker images directly in this harness, so the runner rebuilds each environment from the same SWE-Smith profile recipe the image was built from (see `data/README.md`). The prepare step also rewrites `solution/solve.sh` into a deterministic idempotent form, and the verifier runs as a non-root `agent` user to match task-image semantics.

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

1. **Cold-gold provider runs.** `ts/src/bench.ts` ran solver-independent gold-patch checks for Vercel, Modal, and Daytona across `data/swesmith_v4_smoke100.jsonl`, with focused reruns for repaired failure clusters.
2. **Evidence aggregation.** The regenerated reports scan local ignored `results/ts-<provider>-cold-gold*.json` files and select the newest passing result for each provider/task. If no passing result exists, they select the newest cold-gold result.
3. **Curated analysis.** The cross-vendor, per-task, and failure-mode documents summarize the full 100-task comparable set and call out that the timing view is stitched from full and focused reruns.

The `Updated:` date in each curated report reflects when the analysis was last revised, not when the benchmark runs executed.

## Provider Notes

Provider-specific setup details live in [docs/providers/](docs/providers/).

- Vercel uses `@vercel/sandbox`. Configure `VERCEL_API_KEY`, `VERCEL_ACCESS_TOKEN`, or `VERCEL_TOKEN`, plus `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` unless OIDC credentials are available.
- Modal uses the Modal SDK credentials supported by `modal`.
- Daytona uses `DAYTONA_API_KEY` and, when needed, `DAYTONA_API_URL` and `DAYTONA_TARGET`.
- AWS Lambda MicroVMs uses `@aws-sdk/client-lambda-microvms`. Build a runner image once with `bun run prewarm --provider aws-microvm --aws-bucket <bucket> --aws-build-role-arn <role-arn> --output ../results/prewarm-aws-microvm.json`, then reuse the emitted `AWS_MICROVM_IMAGE_ID` for `bench` or `matrix` runs. Runtime execution can use `AWS_MICROVM_EXECUTION_ROLE_ARN` when the MicroVM needs AWS service access; the benchmark runner itself only needs ingress/egress connectors.
- Cost estimates are harness estimates from measured wall-clock time and configured provider rates. They exclude OpenRouter model spend.

### Warm Artifacts And Saved State

Auth credentials live in `.env` (see `.env.example`). Warm-run state — the snapshot/image identifiers reused to skip cold setup — is **not** stored in `.env`. Instead, `ts/src/prewarm.ts` creates the artifact and emits its identifier as an `env` field in the prewarm result JSON under `results/`:

provider | identifier | emitted to | reused via
--- | --- | --- | ---
Vercel | `VERCEL_SNAPSHOT_ID` | `results/prewarm-vercel-*.json` | `--vercel-snapshot-id` or the `VERCEL_SNAPSHOT_ID` env var
Modal | `MODAL_IMAGE_ID` | `results/prewarm-modal-*.json` | `--modal-image-id` or the `MODAL_IMAGE_ID` env var
Daytona | `DAYTONA_SNAPSHOT` | `results/prewarm-daytona-*.json` | `--daytona-snapshot` or the `DAYTONA_SNAPSHOT` env var
AWS Lambda MicroVMs | `AWS_MICROVM_IMAGE_ID` | `results/prewarm-aws-microvm-*.json` | `--aws-microvm-image-id` or the `AWS_MICROVM_IMAGE_ID` env var

To run warm, copy the identifier from the prewarm result JSON into the corresponding flag or env var on the next `bench.ts`/`matrix.ts` run. For TerminalBench (non-Docker) tasks, Daytona instead uses a cached profile via `--prewarm-profile` (default `terminalbench-smoke`) rather than a named snapshot.

Note: the Vercel fallback's repo-specific dependency repair for SWE-Smith tasks is **not** configured through environment variables — it is in-code setup in `ts/src/bench.ts`. See [reports/failure-modes-tradeoffs.md](reports/failure-modes-tradeoffs.md) for the rationale.
