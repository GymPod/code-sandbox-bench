# Bun / TypeScript Runner

Install:

```bash
npm install
```

Run one local verifier:

```bash
bun run bench --provider local --task-index 0 --output ../results/ts-local-one.json
```

Run all tasks with the Vercel Sandbox SDK:

```bash
bun run bench --provider vercel --task-index all --output ../results/ts-vercel-all.json
```

Run all tasks with Modal:

```bash
bun run bench --provider modal --task-index all --output ../results/ts-modal-all.json
```

Run all tasks with Daytona:

```bash
bun run bench --provider daytona --task-index all --output ../results/ts-daytona-all.json
```

The TypeScript runner reads `../data/terminalbench_2026_03_05_smoke16.jsonl` and supports `local`, `vercel`, `modal`, and `daytona`. Use `--concurrency N` to run tasks in parallel, for example `--concurrency 4`.
