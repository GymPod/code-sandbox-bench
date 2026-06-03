# code-sandbox-bench

Standalone benchmark harness for running TerminalBench and SWE-Smith smoke sets across coding sandbox providers.

The repo contains both Python and Bun/TypeScript implementations so the runner can be chosen by ecosystem:

- `py/`: Python runner with `local`, `vercel`, `modal`, and `daytona` provider adapters.
- `ts/`: Bun/TypeScript runner with `local`, `vercel`, `modal`, and `daytona` provider adapters, plus the same dataset and output schema.
- `data/`: bundled TerminalBench and SWE-Smith smoke parquet files plus JSONL mirrors for runtimes that do not need parquet parsing.
- `reports/`: current PR report with measured Vercel results and normalized provider cost comparison.

## Dataset

Included files:

- `data/terminalbench_2026_03_05_smoke16.parquet`
- `data/terminalbench_2026_03_05_smoke16.jsonl`
- `data/swesmith_v4_smoke100.parquet`
- `data/swesmith_v4_smoke100.jsonl`

The JSONL mirror preserves `task_id`, `prompt`, `instruction`, and the `tar.gz+base64` task archive from the parquet row.

The SWE-Smith smoke set was extracted from `~/Downloads/swesmith-v4_train_2026_05_15.parquet` with:

```bash
python scripts/extract_harbor_smoke.py --input ~/Downloads/swesmith-v4_train_2026_05_15.parquet --count 100 --strategy even --output-parquet data/swesmith_v4_smoke100.parquet --output-jsonl data/swesmith_v4_smoke100.jsonl
```

SWE-Smith rows include verifier scripts under `tests/test.sh`, solution artifacts under `solution/`, and `env_type=harbor_swesmith`. The TypeScript runner maps that env type to `/testbed` and the task Docker image declared by `environment/Dockerfile`; Modal and Daytona use that image as the task runtime, while Vercel needs an equivalent prebuilt runtime or snapshot.

## Quick Start

Python:

```bash
cd py && uv venv && source .venv/bin/activate && uv pip install -e ".[providers]" && cp ../.env.example ../.env
```

```bash
cd py && python -m code_sandbox_bench.bench --provider local --task-index 0 --output ../results/local-one.json
```

Bun/TypeScript:

```bash
cd ts && npm install && cp ../.env.example ../.env
```

```bash
cd ts && bun run bench --provider local --task-index 0 --output ../results/ts-local-one.json
```

## Solve Price Matrix

The main comparison is solve-enabled cold vs warm provider cost on the 100-task SWE-Smith smoke set. The TypeScript runner defaults to `--concurrency 100`, and the matrix runner launches all provider/mode runs concurrently. Matrix runs apply provider-specific task concurrency caps by default for Modal and Daytona so the run does not immediately trip known sandbox creation rate, CPU, or memory limits; override them with `--modal-concurrency`, `--daytona-concurrency`, or `--vercel-concurrency` when the provider quota allows it.

Run the full Vercel, Modal, and Daytona cold/warm matrix:

```bash
SOLVER_MAX_STEPS=3 SOLVER_STEP_TIMEOUT_SECONDS=300 bun --env-file=.env ts/src/matrix.ts --providers all --modes cold,warm --concurrency 100 --run-concurrency 6 --output results/solve-price-matrix-$(date +%Y%m%d).json
```

For task-Docker datasets such as SWE-Smith, the matrix runner does not reuse generic Modal or Daytona warm artifacts because each task needs the Docker image declared by its own `environment/Dockerfile`. Vercel cannot consume those per-task Docker images directly, so SWE-Smith Vercel runs need an equivalent task-compatible runtime or snapshot.

The matrix produces:

- `results/ts-vercel-cold-solve-all-YYYYMMDD.json`
- `results/ts-vercel-warm-solve-all-YYYYMMDD.json`
- `results/ts-modal-cold-solve-all-YYYYMMDD.json`
- `results/ts-modal-warm-solve-all-YYYYMMDD.json`
- `results/ts-daytona-cold-solve-all-YYYYMMDD.json`
- `results/ts-daytona-warm-solve-all-YYYYMMDD.json`

Rebuild the solve-only price report from the newest available artifacts:

```bash
bun --env-file=.env ts/src/report.ts --results-dir results --output reports/terminalbench_provider_report.md
```

Run one solve-enabled provider/mode manually:

```bash
SOLVER_MAX_STEPS=3 SOLVER_STEP_TIMEOUT_SECONDS=300 bun --env-file=.env ts/src/bench.ts --provider modal --mode cold --task-index all --dataset data/swesmith_v4_smoke100.jsonl --runtime python:3.13 --timeout-seconds 180 --solve-timeout-seconds 900 --concurrency 100 --forward-env OPENROUTER_API_KEY,OPENROUTER_MODEL,SOLVER_MAX_STEPS,SOLVER_STEP_TIMEOUT_SECONDS --solve-command-file scripts/openrouter_solver.sh --output results/ts-modal-cold-solve-all.json
```

The bundled `scripts/openrouter_solver.sh` is a lightweight OpenRouter shell-agent loop. It reads the task file and workdir exported by the harness (`BENCH_TASK_FILE`, `BENCH_TASK_WORKDIR`), asks OpenRouter for a bash repair script, executes it, runs the verifier for feedback, and retries up to `SOLVER_MAX_STEPS` times. Set `OPENROUTER_MODEL` in `.env` to pin a model; otherwise OpenRouter uses the account default model.

When `--solve-command` or `--solve-command-file` is set, the harness runs:

1. Prepare task files in `/workspace`, tests in `/tests`, and solution artifacts in `/solution` when present.
2. Write task instructions to `/workspace/TASK.md` and to the mapped task workdir when it differs.
3. Run the solver command from the mapped task workdir.
4. Run the verifier.

Use `--forward-env NAME,OTHER_NAME` to copy selected local environment variables into the remote solver command. The harness does not record forwarded values in the result JSON.

## Prewarm And Snapshot Runs

Create reusable warm artifacts:

```bash
bun --env-file=.env ts/src/prewarm.ts --provider vercel --runtime python3.13 --profile terminalbench-smoke --output results/prewarm-vercel-terminalbench-20260528.json
```

```bash
bun --env-file=.env ts/src/prewarm.ts --provider modal --runtime python:3.13 --profile terminalbench-smoke --output results/prewarm-modal-terminalbench-20260528.json
```

Run warm solve-enabled comparisons with OpenRouter manually:

```bash
SOLVER_MAX_STEPS=3 SOLVER_STEP_TIMEOUT_SECONDS=300 bun --env-file=.env ts/src/bench.ts --provider vercel --mode warm --task-index all --runtime python3.13 --timeout-seconds 180 --solve-timeout-seconds 900 --concurrency 16 --forward-env OPENROUTER_API_KEY,OPENROUTER_MODEL,SOLVER_MAX_STEPS,SOLVER_STEP_TIMEOUT_SECONDS --solve-command-file scripts/openrouter_solver.sh --vercel-snapshot-id "$VERCEL_SNAPSHOT_ID" --output results/ts-vercel-warm-solve-all.json
```

```bash
SOLVER_MAX_STEPS=3 SOLVER_STEP_TIMEOUT_SECONDS=300 bun --env-file=.env ts/src/bench.ts --provider modal --mode warm --task-index all --runtime python:3.13 --timeout-seconds 180 --solve-timeout-seconds 900 --concurrency 16 --forward-env OPENROUTER_API_KEY,OPENROUTER_MODEL,SOLVER_MAX_STEPS,SOLVER_STEP_TIMEOUT_SECONDS --solve-command-file scripts/openrouter_solver.sh --modal-image-id "$MODAL_IMAGE_ID" --output results/ts-modal-warm-solve-all.json
```

```bash
SOLVER_MAX_STEPS=3 SOLVER_STEP_TIMEOUT_SECONDS=300 bun --env-file=.env ts/src/bench.ts --provider daytona --mode warm --task-index all --runtime python:3.13 --timeout-seconds 180 --solve-timeout-seconds 900 --concurrency 16 --forward-env OPENROUTER_API_KEY,OPENROUTER_MODEL,SOLVER_MAX_STEPS,SOLVER_STEP_TIMEOUT_SECONDS --solve-command-file scripts/openrouter_solver.sh --prewarm-profile terminalbench-smoke --output results/ts-daytona-warm-solve-all.json
```

## What The Benchmark Does

For each task, the harness:

1. Starts a sandbox.
2. Writes the bundled task archive into the sandbox.
3. Extracts task files into `/workspace` and tests into `/tests`.
4. Installs `pytest`.
5. Optionally runs a solver/completion command in `/workspace`.
6. Runs `bash /tests/test.sh` when present, otherwise `pytest /tests/test_outputs.py`.
7. Records verifier exit code, elapsed time, output tails, and cost estimate.

Use `--solve-command` or `--solve-command-file` for benchmark comparisons. Verifier-only runs are still supported for local smoke checks, but they are excluded from the provider price report because they do not represent an actual task-solving workload.

## Notes

- Vercel uses `@vercel/sandbox`. For local access-token auth, set `VERCEL_API_KEY`, `VERCEL_ACCESS_TOKEN`, or `VERCEL_TOKEN`, plus `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`. The SDK can also use Vercel OIDC credentials when available.
- Modal requires the Modal SDK credentials supported by `modal`.
- Daytona requires `DAYTONA_API_KEY` and, when not using SDK defaults, `DAYTONA_API_URL` and `DAYTONA_TARGET`. The current Daytona API key did not have permission for named snapshot creation, so the warm Daytona runs use a cached image definition via `--prewarm-profile terminalbench-smoke`.
- Cost estimates are upper bounds based on wall-clock duration. See `reports/terminalbench_provider_report.md` for the current cold/warm solve price comparison.
