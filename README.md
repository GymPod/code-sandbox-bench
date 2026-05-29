# code-sandbox-bench

Standalone benchmark harness for running the 16-task TerminalBench smoke set across coding sandbox providers.

The repo contains both Python and Bun/TypeScript implementations so the runner can be chosen by ecosystem:

- `py/`: Python runner with `local`, `vercel`, `modal`, and `daytona` provider adapters.
- `ts/`: Bun/TypeScript runner with `local`, `vercel`, `modal`, and `daytona` provider adapters, plus the same dataset and output schema.
- `data/`: bundled TerminalBench smoke parquet and a JSONL mirror for runtimes that do not need parquet parsing.
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

SWE-Smith rows include verifier scripts under `tests/test.sh` and solution artifacts under `solution/`. They also expect their task Docker image to provide `/testbed`, conda, and `/opt/verifier-venv`; the current generic `python:3.13` provider runs can load and invoke these tasks, but full SWE-Smith verification needs per-task Dockerfile/image support.

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

## Provider Commands

Python all-task runs:

```bash
cd py && python -m code_sandbox_bench.bench --provider vercel --task-index all --output ../results/vercel-all.json
```

```bash
cd py && python -m code_sandbox_bench.bench --provider modal --task-index all --output ../results/modal-all.json
```

```bash
cd py && python -m code_sandbox_bench.bench --provider daytona --task-index all --output ../results/daytona-all.json
```

Bun/TypeScript all-task runs:

```bash
cd ts && bun run bench --provider vercel --task-index all --output ../results/ts-vercel-all.json
```

```bash
cd ts && bun run bench --provider modal --task-index all --output ../results/ts-modal-all.json
```

```bash
cd ts && bun run bench --provider daytona --task-index all --output ../results/ts-daytona-all.json
```

Run with a solver/completion phase:

```bash
bun --env-file=.env ts/src/bench.ts --provider modal --task-index all --runtime python:3.13 --timeout-seconds 180 --solve-timeout-seconds 900 --concurrency 4 --forward-env OPENROUTER_API_KEY,OPENROUTER_MODEL --solve-command-file scripts/openrouter_solver.sh --output results/ts-modal-solve-all.json
```

```bash
bun --env-file=.env ts/src/bench.ts --provider daytona --task-index all --runtime python:3.13 --timeout-seconds 180 --solve-timeout-seconds 900 --concurrency 2 --forward-env OPENROUTER_API_KEY,OPENROUTER_MODEL --solve-command-file scripts/openrouter_solver.sh --output results/ts-daytona-solve-all.json
```

The bundled `scripts/openrouter_solver.sh` is a lightweight OpenRouter shell-agent loop. It reads `/workspace/TASK.md` and `/tests/test_outputs.py`, asks OpenRouter for a bash repair script, executes it, runs the verifier for feedback, and retries up to `SOLVER_MAX_STEPS` times. Set `OPENROUTER_MODEL` in `.env` to pin a model; otherwise OpenRouter uses the account default model.

When `--solve-command` or `--solve-command-file` is set, the harness runs:

1. Prepare task files in `/workspace` and tests in `/tests`.
2. Write `/workspace/TASK.md`, `/tmp/task_prompt.md`, and `/tmp/task_instruction.md`.
3. Run the solver command from `/workspace`.
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

Run the warm snapshot/profile verifier matrix:

```bash
bun --env-file=.env ts/src/bench.ts --provider vercel --task-index all --runtime python3.13 --timeout-seconds 180 --vercel-snapshot-id "$VERCEL_SNAPSHOT_ID" --output results/ts-vercel-warm-verifier-all.json
```

```bash
bun --env-file=.env ts/src/bench.ts --provider modal --task-index all --runtime python:3.13 --timeout-seconds 180 --modal-image-id "$MODAL_IMAGE_ID" --output results/ts-modal-warm-verifier-all.json
```

```bash
bun --env-file=.env ts/src/bench.ts --provider daytona --task-index all --runtime python:3.13 --timeout-seconds 180 --prewarm-profile terminalbench-smoke --concurrency 1 --output results/ts-daytona-warm-verifier-all.json
```

Run warm solve-enabled comparisons with OpenRouter:

```bash
SOLVER_MAX_STEPS=3 SOLVER_STEP_TIMEOUT_SECONDS=300 bun --env-file=.env ts/src/bench.ts --provider vercel --task-index all --runtime python3.13 --timeout-seconds 180 --solve-timeout-seconds 900 --concurrency 1 --forward-env OPENROUTER_API_KEY,OPENROUTER_MODEL,SOLVER_MAX_STEPS,SOLVER_STEP_TIMEOUT_SECONDS --solve-command-file scripts/openrouter_solver.sh --vercel-snapshot-id "$VERCEL_SNAPSHOT_ID" --output results/ts-vercel-warm-solve-all.json
```

```bash
SOLVER_MAX_STEPS=3 SOLVER_STEP_TIMEOUT_SECONDS=300 bun --env-file=.env ts/src/bench.ts --provider modal --task-index all --runtime python:3.13 --timeout-seconds 180 --solve-timeout-seconds 900 --concurrency 2 --forward-env OPENROUTER_API_KEY,OPENROUTER_MODEL,SOLVER_MAX_STEPS,SOLVER_STEP_TIMEOUT_SECONDS --solve-command-file scripts/openrouter_solver.sh --modal-image-id "$MODAL_IMAGE_ID" --output results/ts-modal-warm-solve-all.json
```

```bash
SOLVER_MAX_STEPS=3 SOLVER_STEP_TIMEOUT_SECONDS=300 bun --env-file=.env ts/src/bench.ts --provider daytona --task-index all --runtime python:3.13 --timeout-seconds 180 --solve-timeout-seconds 900 --concurrency 1 --forward-env OPENROUTER_API_KEY,OPENROUTER_MODEL,SOLVER_MAX_STEPS,SOLVER_STEP_TIMEOUT_SECONDS --solve-command-file scripts/openrouter_solver.sh --prewarm-profile terminalbench-smoke --output results/ts-daytona-warm-solve-all.json
```

Rebuild the report from result JSONs:

```bash
bun --env-file=.env ts/src/report.ts --output reports/terminalbench_provider_report.md
```

## What The Benchmark Does

For each task, the harness:

1. Starts a sandbox.
2. Writes the bundled task archive into the sandbox.
3. Extracts task files into `/workspace` and tests into `/tests`.
4. Installs `pytest`.
5. Optionally runs a solver/completion command in `/workspace`.
6. Runs `bash /tests/test.sh`.
7. Records verifier exit code, elapsed time, output tails, and cost estimate.

By default, the benchmark is verifier-only. It does not run a solver/model edit step unless `--solve-command` or `--solve-command-file` is provided, so the bundled smoke set is expected to fail as-is. The useful verifier-only signal is provider setup, execution, snapshot potential, timing, and estimated cost.

## Notes

- Vercel uses `@vercel/sandbox`. For local access-token auth, set `VERCEL_API_KEY`, `VERCEL_ACCESS_TOKEN`, or `VERCEL_TOKEN`, plus `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`. The SDK can also use Vercel OIDC credentials when available.
- Modal requires the Modal SDK credentials supported by `modal`.
- Daytona requires `DAYTONA_API_KEY` and, when not using SDK defaults, `DAYTONA_API_URL` and `DAYTONA_TARGET`. The current Daytona API key did not have permission for named snapshot creation, so the warm Daytona runs use a cached image definition via `--prewarm-profile terminalbench-smoke`.
- Cost estimates are upper bounds based on wall-clock duration. See `reports/terminalbench_provider_report.md` for the current measured Vercel run and normalized side-by-side table.
