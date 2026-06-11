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
- `bun run triage`: classify failed tasks from result JSON files into provider-transport, environment-fidelity, patch-application, timeout, and real-test-failure buckets.

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

How it works:

- `src/report.ts` scans `--results-dir` for the newest `ts-<provider>-<mode>-solve-all*.json` file for each provider (vercel, modal, daytona) and mode (cold, warm), preferring date-suffixed files. Missing provider/mode combinations are noted rather than failing the run.
- For each discovered run it computes pass counts, total/mean/median/p95 elapsed seconds, harness cost estimates, mean per-phase timings (`start`, `upload`, `prepare`, `instruction write`, `solve`, `verify`, `stop`), and per-task tables.
- The input JSONs come from `src/bench.ts` (single provider/mode runs) or `src/matrix.ts` (concurrent matrices). Warm runs depend on artifacts created by `src/prewarm.ts` (Vercel snapshot, Modal image, or Daytona prewarm profile).

## Task Runtime Mapping

- `terminalbench` tasks run from `/workspace` on the configured runtime.
- `harbor_swesmith` tasks run from `/testbed`.
- Modal and Daytona can use task Docker images or Dockerfile-derived setup.
- Vercel (and local) reconstruct the task environment from the per-repo manifest in `../data/swesmith_env_manifests.json`: the exact Python version is provisioned with uv into `/opt/testbed-venv`, the SWE-Smith mirror repo is cloned at the task branch, and the profile's install commands run inside the venv. The verifier venv matches the task image's (pytest/swebench/swesmith), so grading uses the task's real FAIL_TO_PASS/PASS_TO_PASS lists. Per-repo overrides live in `../data/swesmith_env_overrides.json`; regenerate the manifest with `python3 ../scripts/build_env_manifests.py`.

For SWE-Smith tasks the prepare step also rewrites `/solution/solve.sh` into a deterministic, idempotent form (reverse-applies the gold patch only while it is still present), and the verifier runs as the unprivileged `agent` user when possible so permission-sensitive test suites behave like they do in the task Docker image. Per-repo resource overrides (`resources` in the manifest) raise cpu/memory/disk for heavy repos such as pandas and MONAI.

## Gold Runnability Check

To verify that every task environment can apply the reference solution and pass its verifier on a provider (no LLM involved):

```bash
bun --env-file=../.env src/bench.ts --provider vercel --mode cold --task-index all --task-limit 100 --timeout-seconds 900 --solve-timeout-seconds 300 --solve-command-file ../scripts/gold_solver.sh --output ../results/ts-vercel-cold-gold-all.json
```

## Failure Triage

```bash
bun run triage ../results/ts-vercel-cold-solve-all-*.json --output ../reports/generated-triage.md
```

## Validation

```bash
bun run typecheck
```
