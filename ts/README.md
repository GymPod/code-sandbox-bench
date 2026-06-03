# Bun / TypeScript Runner

Install:

```bash
npm install
```

Run one local smoke task:

```bash
bun run bench --provider local --task-index 0 --output ../results/ts-local-one.json
```

Run all SWE-Smith smoke tasks with a solver and full task concurrency:

```bash
bun run bench --provider modal --mode cold --dataset ../data/swesmith_v4_smoke100.jsonl --task-index all --concurrency 100 --solve-timeout-seconds 900 --forward-env OPENROUTER_API_KEY,OPENROUTER_MODEL,SOLVER_MAX_STEPS,SOLVER_STEP_TIMEOUT_SECONDS --solve-command-file ../scripts/openrouter_solver.sh --output ../results/ts-modal-cold-solve-all.json
```

Run the full cold/warm provider price matrix:

```bash
bun run matrix --providers all --modes cold,warm --concurrency 100 --run-concurrency 6 --output ../results/solve-price-matrix.json
```

Rebuild the solve-only price report:

```bash
bun run report --results-dir ../results --output ../reports/terminalbench_provider_report.md
```

The TypeScript runner defaults to `../data/swesmith_v4_smoke100.jsonl` and supports `local`, `vercel`, `modal`, and `daytona`. Task concurrency defaults to 100 for direct bench runs. `harbor_swesmith` tasks map to `/testbed` and their task Docker image where the provider supports registry images. The matrix runner launches provider/mode runs concurrently; `--run-concurrency 6` runs Vercel, Modal, and Daytona cold/warm runs at the same time, while default Modal and Daytona task concurrency caps avoid known provider rate, CPU, and memory limits. Override with `--modal-concurrency`, `--daytona-concurrency`, or `--vercel-concurrency` when quota allows it.
