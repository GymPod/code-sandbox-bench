# Results

Checked-in benchmark artifacts and investigation probes.

## Naming

Common result names use:

```text
ts-<provider>-<mode>-solve-all-<suffix>.json
solve-price-matrix-<suffix>.json
```

Examples:

- `ts-vercel-cold-solve-all-gold-task20-vercel-current-rerun.json`
- `ts-modal-warm-solve-all-gold-task20-envfix.json`
- `solve-price-matrix-gold-task20-vercel-current-rerun.json`

Provider files contain per-task results. Matrix files summarize a set of provider/mode runs.

## Current Report Inputs

The curated reports use these files:

- `ts-vercel-cold-solve-all-gold-task20-vercel-current-rerun.json`
- `ts-vercel-warm-solve-all-gold-task20-vercel-current-rerun.json`
- `ts-modal-cold-solve-all-gold-task20-envfix.json`
- `ts-modal-warm-solve-all-gold-task20-envfix.json`
- `ts-daytona-cold-solve-all-gold-task20-envfix.json`
- `ts-daytona-warm-solve-all-gold-task20-envfix.json`

See `../reports/terminalbench_provider_report.md` for the report index.

## Artifact Types

- `prewarm-*`: warm artifact creation or inspection output.
- `*-verifier-*`: verifier-only checks. Daytona verifier artifacts live under `verifier/`.
- `*-solve-*`: solver-enabled runs.
- `*-env-*`, `*-probe*`, `*-trace*`: provider or task-environment investigations.

Result JSON may include output tails from task logs. Do not store secrets in task output or forwarded environment values.
