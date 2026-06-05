# Sandbox Provider Report

Updated: 2026-06-05

This report is split into focused documents:

- [Cross-vendor comparison](cross-vendor-comparison.md): the apples-to-apples provider comparison, centered on the 13 tasks that pass on Vercel, Modal, and Daytona in both cold and warm modes.
- [Per-task comparison](per-task-comparison.md): task-by-task status and timing for the current 20-task SWE-Smith evidence set.
- [Failure modes and trade-offs](failure-modes-tradeoffs.md): environment gaps, provider-specific failures, and interpretation notes.

## Evidence Set

The focused comparison uses the first 20 tasks from `data/swesmith_v4_smoke100.jsonl`.

Vercel uses the latest rerun after fallback verifier fixes:

- `results/ts-vercel-cold-solve-all-gold-task20-vercel-current-rerun.json`
- `results/ts-vercel-warm-solve-all-gold-task20-vercel-current-rerun.json`

Modal and Daytona use the latest complete task20 env-fix artifacts:

- `results/ts-modal-cold-solve-all-gold-task20-envfix.json`
- `results/ts-modal-warm-solve-all-gold-task20-envfix.json`
- `results/ts-daytona-cold-solve-all-gold-task20-envfix.json`
- `results/ts-daytona-warm-solve-all-gold-task20-envfix.json`

## Headline

On the 13-task all-provider-passing subset, Daytona is fastest and lowest estimated provider cost, Modal is next, and Vercel is slowest for this SWE-Smith fallback-runtime workload.

provider | cold seconds | warm seconds | cold cost | warm cost
--- | ---: | ---: | ---: | ---:
vercel | 659.4 | 670.8 | $0.0624 | $0.0635
modal | 559.3 | 523.5 | $0.0371 | $0.0347
daytona | 385.8 | 349.8 | $0.0178 | $0.0161

The broader 20-task rollup is useful for coverage, but it mixes genuine solver/test failures with provider fidelity gaps. Use the cross-vendor subset as the main price/performance comparison.
