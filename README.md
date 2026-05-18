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

The JSONL mirror preserves `task_id`, `prompt`, `instruction`, and the `tar.gz+base64` task archive from the parquet row.

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

## What The Benchmark Does

For each task, the harness:

1. Starts a sandbox.
2. Writes the bundled task archive into the sandbox.
3. Extracts task files into `/workspace` and tests into `/tests`.
4. Installs `pytest`.
5. Runs `bash /tests/test.sh`.
6. Records verifier exit code, elapsed time, output tails, and cost estimate.

The benchmark is verifier-only. It does not run a solver/model edit step, so the bundled smoke set is expected to fail as-is. The useful signal is provider setup, execution, snapshot potential, timing, and estimated cost.

## Notes

- Vercel uses `@vercel/sandbox`. For local access-token auth, set `VERCEL_ACCESS_TOKEN` or `VERCEL_TOKEN`, plus `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`. The SDK can also use Vercel OIDC credentials when available.
- Modal requires the Modal SDK credentials supported by `modal`.
- Daytona requires `DAYTONA_API_KEY` and, when not using SDK defaults, `DAYTONA_API_URL` and `DAYTONA_TARGET`.
- Cost estimates are upper bounds based on wall-clock duration. See `reports/terminalbench_provider_report.md` for the current measured Vercel run and normalized side-by-side table.
