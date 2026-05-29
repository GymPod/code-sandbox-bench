# TerminalBench Sandbox Provider Report

Generated: 2026-05-29T17:48:25.729Z

## Scope

- Dataset: `data/terminalbench_2026_03_05_smoke16.jsonl` (16 tasks).
- Expanded smoke dataset: `data/swesmith_v4_smoke100.jsonl` (100 evenly sampled SWE-Smith tasks from `~/Downloads/swesmith-v4_train_2026_05_15.parquet`).
- Verifier-only runs cover cold and warm startup for Vercel, Modal, and Daytona.
- Solve runs cover warm/snapshot startup for all three providers using `scripts/openrouter_solver.sh` with `deepseek/deepseek-v4-flash` through OpenRouter.
- Vercel warm uses snapshot `snap_TkzxZLA3B7Jij3GonaqFkUFhSo2K`; Modal warm uses image `im-PN0mo0YJNhDkPn6VWNCLz4`.
- Daytona named snapshot creation returned `403 Forbidden` with the current API key, so Daytona warm uses the cached `terminalbench-smoke` image definition path rather than a named snapshot.

## Rollup

provider | mode | kind | passed | total seconds | mean seconds | median seconds | p95 seconds | estimated provider cost
--- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---:
vercel | cold | verifier | 0/16 | 172.16 | 10.76 | 11.20 | 16.97 | $0.0163
vercel | warm | verifier | 0/16 | 169.18 | 10.57 | 10.89 | 17.61 | $0.0160
modal | cold | verifier | 0/16 | 117.44 | 7.34 | 6.98 | 8.70 | $0.0078
modal | warm | verifier | 0/16 | 126.29 | 7.89 | 7.43 | 11.91 | $0.0084
daytona | cold | verifier | 0/16 | 104.43 | 6.53 | 6.67 | 7.34 | $0.0048
daytona | warm | verifier | 0/16 | 63.05 | 3.94 | 3.77 | 4.98 | $0.0029
vercel | warm | solve | 9/16 | 1348.16 | 84.26 | 76.79 | 165.87 | $0.1276
modal | warm | solve | 11/16 | 1448.34 | 90.52 | 77.92 | 181.65 | $0.0960
daytona | warm | solve | 10/16 | 1544.11 | 96.51 | 84.63 | 243.60 | $0.0713

## Mean Phase Seconds

provider | mode | kind | start | upload | prepare | instruction write | solve | verify | stop
--- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---:
vercel | cold | verifier | 0.22 | 4.62 | 0.95 | 2.07 | - | 0.86 | 2.04
vercel | warm | verifier | 0.24 | 4.29 | 1.01 | 2.03 | - | 0.89 | 2.12
modal | cold | verifier | 0.67 | 1.73 | 2.65 | 1.36 | - | 0.80 | 0.13
modal | warm | verifier | 0.78 | 1.96 | 2.76 | 1.34 | - | 0.94 | 0.12
daytona | cold | verifier | 1.92 | 0.25 | 3.15 | 0.67 | - | 0.42 | 0.12
daytona | warm | verifier | 0.83 | 0.27 | 1.43 | 0.73 | - | 0.55 | 0.13
vercel | warm | solve | 0.23 | 2.29 | 1.08 | 2.27 | 75.42 | 0.87 | 2.10
modal | warm | solve | 0.66 | 1.66 | 2.67 | 1.52 | 82.89 | 0.87 | 0.25
daytona | warm | solve | 0.87 | 0.29 | 1.44 | 0.78 | 92.20 | 0.80 | 0.13

## Warm Solve Per Task

task | vercel | modal | daytona
--- | --- | --- | ---
R_package_dependency_missing_medium | fail 114.21s $0.0108 | pass 44.43s $0.0029 | pass 164.22s $0.0076
Rscript_segfault_debugging_hard | pass 103.80s $0.0098 | pass 118.71s $0.0079 | pass 107.79s $0.0050
Rscript_segfault_debugging_medium | pass 43.94s $0.0042 | pass 56.40s $0.0037 | pass 56.31s $0.0026
a_b_testing_models_hard | pass 71.20s $0.0067 | pass 51.21s $0.0034 | pass 46.07s $0.0021
a_b_testing_models_medium | pass 34.17s $0.0032 | pass 79.85s $0.0053 | pass 68.67s $0.0032
a_star_pathfinding_hard | fail 152.02s $0.0144 | fail 75.98s $0.0050 | fail 127.99s $0.0059
a_star_pathfinding_medium | fail 54.24s $0.0051 | pass 97.38s $0.0065 | pass 46.86s $0.0022
aar_android_library_packaging_hard | fail 50.62s $0.0048 | fail 101.72s $0.0067 | fail 105.27s $0.0049
aar_android_library_packaging_medium | fail 95.25s $0.0090 | fail 181.55s $0.0120 | fail 76.26s $0.0035
abc_synthesis_optimization_hard | pass 37.53s $0.0036 | pass 30.14s $0.0020 | pass 19.25s $0.0009
abc_synthesis_optimization_medium | fail 66.60s $0.0063 | fail 143.64s $0.0095 | fail 87.32s $0.0040
abi_compliance_checker_tool_hard | pass 34.16s $0.0032 | pass 33.04s $0.0022 | pass 81.94s $0.0038
abi_compliance_checker_tool_medium | pass 82.38s $0.0078 | pass 63.32s $0.0042 | fail 102.88s $0.0047
acl2_induction_scheme_selection_hard | pass 93.55s $0.0089 | pass 148.35s $0.0098 | pass 243.60s $0.0112
acl2_induction_scheme_selection_medium | pass 148.62s $0.0141 | pass 40.97s $0.0027 | pass 132.08s $0.0061
aclocal_macro_not_found_hard | fail 165.87s $0.0157 | fail 181.65s $0.0120 | fail 77.61s $0.0036

## Failed Warm Solve Tasks

- vercel: R_package_dependency_missing_medium, a_star_pathfinding_hard, a_star_pathfinding_medium, aar_android_library_packaging_hard, aar_android_library_packaging_medium, abc_synthesis_optimization_medium, aclocal_macro_not_found_hard
- modal: a_star_pathfinding_hard, aar_android_library_packaging_hard, aar_android_library_packaging_medium, abc_synthesis_optimization_medium, aclocal_macro_not_found_hard
- daytona: a_star_pathfinding_hard, aar_android_library_packaging_hard, aar_android_library_packaging_medium, abc_synthesis_optimization_medium, abi_compliance_checker_tool_medium, aclocal_macro_not_found_hard

## Expanded SWE-Smith Smoke100

The repository now includes a broader 100-task smoke slice:

- Source parquet: `~/Downloads/swesmith-v4_train_2026_05_15.parquet`
- Rows available in source: `37,497`
- Rows selected: `100`
- Sampling strategy: evenly spaced by row index for deterministic repository/task diversity
- Output parquet: `data/swesmith_v4_smoke100.parquet`
- Output JSONL: `data/swesmith_v4_smoke100.jsonl`

This dataset is structurally compatible with the harness JSONL loader: each row has `task_id`, `prompt`, `instruction`, and embedded `task_files`. The SWE-Smith verifier layout differs from TerminalBench: tasks provide `tests/test.sh` and `solution/*`, and expect their Docker image to provide `/testbed`, conda, and `/opt/verifier-venv`. The TypeScript verifier path now runs `/tests/test.sh` when present, but full provider benchmarking on SWE-Smith still needs per-task Dockerfile/image support instead of the generic `python:3.13` runtime.

## Raw Artifacts

- Vercel cold verifier: `results/ts-vercel-cold-verifier-all-20260528.json`
- Vercel warm verifier: `results/ts-vercel-warm-verifier-all-20260528.json`
- Modal cold verifier: `results/ts-modal-cold-verifier-all-20260528.json`
- Modal warm verifier: `results/ts-modal-warm-verifier-all-20260528.json`
- Daytona cold verifier: `results/ts-daytona-cold-verifier-all-20260528.json`
- Daytona warm verifier: `results/ts-daytona-warm-verifier-all-20260528.json`
- Vercel warm solve: `results/ts-vercel-warm-solve-all-20260528.json`
- Modal warm solve: `results/ts-modal-warm-solve-all-20260528.json`
- Daytona warm solve: `results/ts-daytona-warm-solve-all-20260528.json`
- Vercel prewarm: `results/prewarm-vercel-terminalbench-20260528.json`
- Modal prewarm: `results/prewarm-modal-terminalbench-20260528.json`

## Notes

- Verifier-only runs are expected to fail task tests because they only unpack and verify the initial task state. They are useful for launch/setup/upload/verify latency and provider cost.
- Cost estimates are harness estimates based on configured provider rates and measured elapsed time; they do not include OpenRouter model spend.
- The OpenRouter solver is intentionally simple and stores only output tails. Its pass rate is a sandbox-plus-solver smoke signal, not a benchmark of maximum attainable task accuracy.
