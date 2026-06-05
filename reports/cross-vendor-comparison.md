# Cross-Vendor Comparison

Updated: 2026-06-05

This page focuses on tasks that all three providers can execute successfully. That avoids treating provider-specific environment gaps as price/performance signal.

## Inputs

- Dataset slice: first 20 tasks from `data/swesmith_v4_smoke100.jsonl`.
- Vercel: `results/ts-vercel-cold-solve-all-gold-task20-vercel-current-rerun.json`, `results/ts-vercel-warm-solve-all-gold-task20-vercel-current-rerun.json`.
- Modal: `results/ts-modal-cold-solve-all-gold-task20-envfix.json`, `results/ts-modal-warm-solve-all-gold-task20-envfix.json`.
- Daytona: `results/ts-daytona-cold-solve-all-gold-task20-envfix.json`, `results/ts-daytona-warm-solve-all-gold-task20-envfix.json`.

## Comparable Subset

The comparable subset is the 13 tasks that pass on Vercel, Modal, and Daytona in both cold and warm modes.

provider | mode | passed | total seconds | mean seconds | proportional provider cost
--- | --- | ---: | ---: | ---: | ---:
vercel | cold | 13/13 | 659.4 | 50.7 | $0.0624
vercel | warm | 13/13 | 670.8 | 51.6 | $0.0635
modal | cold | 13/13 | 559.3 | 43.0 | $0.0371
modal | warm | 13/13 | 523.5 | 40.3 | $0.0347
daytona | cold | 13/13 | 385.8 | 29.7 | $0.0178
daytona | warm | 13/13 | 349.8 | 26.9 | $0.0161

## Interpretation

- Daytona is fastest and lowest estimated provider cost on the comparable subset.
- Modal is consistently faster and cheaper than Vercel on the comparable subset.
- Vercel warm is slightly slower than Vercel cold in this evidence set because SWE-Smith fallback setup dominates and the run does not use task-specific Docker images.
- The cost column is proportional to each run's measured provider cost and the subset's share of elapsed task seconds. It excludes OpenRouter model spend.

## Comparable Tasks

- `adrienverge__yamllint.8513d9b9.combine_file__26dq3p0r`
- `agronholm__typeguard.b6a7e438.func_basic__x36wmlww`
- `andialbrecht__sqlparse.e57923b3.lm_rewrite__v1mce7cy`
- `benoitc__gunicorn.bacbf8aa.func_basic__460nzix1`
- `bottlepy__bottle.a8dfef30.func_basic__a0p07t6t`
- `cantools__cantools.0c6a7871.combine_file__2yrjny26`
- `cantools__cantools.0c6a7871.func_basic__d9efqrpd`
- `cantools__cantools.0c6a7871.func_pm_ctrl_invert_if__guvo4gx7`
- `cknd__stackprinter.219fcc52.combine_file__gymp2mmm`
- `conan-io__conan.86f29e13.combine_file__7tlw062n`
- `davidhalter__parso.338a5760.func_basic__ru17a9em`
- `dbader__schedule.82a43db1.lm_rewrite__rasm7146`
- `facelessuser__soupsieve.a8080d97.func_basic__32q3kq07`

## Broader 20-Task Coverage

The full 20-task evidence set has different pass rates because some tasks expose provider fidelity gaps or real task failures:

provider | mode | passed | total seconds | estimated provider cost
--- | --- | ---: | ---: | ---:
vercel | cold | 13/20 | 994.5 | $0.0942
vercel | warm | 13/20 | 1023.5 | $0.0969
modal | cold | 17/20 | 1045.4 | $0.0693
modal | warm | 17/20 | 968.4 | $0.0642
daytona | cold | 19/20 | 765.2 | $0.0353
daytona | warm | 19/20 | 698.5 | $0.0322

Use this rollup for coverage and failure analysis, not as the primary vendor comparison.
