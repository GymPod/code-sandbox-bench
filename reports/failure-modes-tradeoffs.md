# Failure Modes And Trade-Offs

Updated: 2026-06-05

This page explains why the full 20-task rollup is not the primary vendor comparison. Detailed task notes are in [per-task-failure-audit.md](per-task-failure-audit.md), and provider-level notes are in [per-provider-report.md](per-provider-report.md).

## Excluded Tasks

The 13-task comparable subset excludes seven tasks from the 20-task evidence set:

- Vercel-only failures: `amueller__word_cloud.ec24191c.func_basic__b5q81acm`, `conan-io__conan.86f29e13.pr_15965`, `dask__dask.5f61e423.combine_module__dkp16syb`.
- Vercel and Modal failures: `conan-io__conan.86f29e13.pr_11412`, `encode__starlette.db5063c2.combine_file__hrjivx2s`, `encode__starlette.db5063c2.func_basic__vehyiaux`.
- Vercel and Daytona failures: `facebookresearch__fvcore.a491d5b9.lm_rewrite__yldgp998`.

## Vercel Fidelity Gaps

SWE-Smith tasks are Docker-image tasks. Modal and Daytona can use task Docker images directly or reconstruct the Dockerfile setup. Vercel cannot consume each per-task Docker image directly in this harness, so Vercel uses a fallback Python runtime plus repo-specific dependency repair.

Important Vercel runtime notes:

- Vercel's `python3.13` runtime lacks `_sqlite3`; `cantools` therefore uses `/usr/bin/python3` when that interpreter can import `sqlite3`.
- Some repos need Python 3.13 behavior, so the fallback cannot globally switch to `/usr/bin/python3`.
- The Vercel verifier clears project-level pytest `addopts` to avoid incompatible coverage/plugin settings.
- Repo-specific dependency fills are intentionally narrow so setup cost does not become global.

## Fvcore And PyTorch

`facebookresearch__fvcore.a491d5b9.lm_rewrite__yldgp998` exposed a Docker-image fidelity gap. Without PyTorch, Vercel hit 14 collection errors. After adding a repo-specific Vercel install of `torch` from `https://download.pytorch.org/whl/cpu`, a targeted Vercel run reached real tests: `155 passed, 3 failed, 2 skipped`.

That is a signal improvement, but not full fidelity. Docker metadata for `jyangballin/swesmith.x86_64.facebookresearch_1776_fvcore.a491d5b9` shows Ubuntu 22.04, Miniconda Python 3.12, and a repo-specific `/root/setup_env.sh`. The manifest includes a 6.6 GB layer, so exact image inspection or pull-based matching is expensive. The durable fix is a Vercel-compatible prebuilt runtime or snapshot derived from the task Docker setup.

## Failure Summary

task | failed providers | failure character
--- | --- | ---
`amueller__word_cloud.ec24191c.func_basic__b5q81acm` | Vercel cold/warm | CLI executable invocation errors.
`conan-io__conan.86f29e13.pr_11412` | Vercel cold/warm, Modal cold/warm | Vercel hits missing `_sqlite3`; Modal reaches real tests and also shows patch rejects.
`conan-io__conan.86f29e13.pr_15965` | Vercel cold/warm | Vercel collection-time autotools test errors.
`dask__dask.5f61e423.combine_module__dkp16syb` | Vercel cold/warm | Real test failures, with `35 failed, 5846 passed`.
`encode__starlette.db5063c2.combine_file__hrjivx2s` | Vercel cold/warm, Modal cold/warm | Staticfiles permission failures, with `2 failed, 865 passed`.
`encode__starlette.db5063c2.func_basic__vehyiaux` | Vercel cold/warm, Modal cold/warm | Staticfiles permission failures, with `2 failed, 865 passed`.
`facebookresearch__fvcore.a491d5b9.lm_rewrite__yldgp998` | Vercel cold/warm, Daytona cold/warm | PyTorch/image fidelity gap on Vercel; remaining real test failures after PyTorch repair; unresolved verifier result on Daytona.

## Provider Trade-Offs

- Daytona is fastest and cheapest on the comparable subset, but Docker/image details matter and earlier high-concurrency runs hit CPU and memory limits.
- Modal handles task Docker images well, but previous high-concurrency runs exposed sandbox creation and shutdown rate issues.
- Vercel has good sandbox startup behavior, but SWE-Smith Docker-image fidelity must be approximated unless we build per-task-compatible snapshots.
- Warm runs only compare cleanly when they use the same task set, solver command, model, resources, and concurrency. For SWE-Smith task Docker images, generic warm artifacts are less useful than task-compatible image/runtime reuse.

## Scaling To 100 Tasks

The comparable subset is 13 of the first 20 tasks. `data/swesmith_v4_smoke100.jsonl` has 100 tasks, so the remaining 80 are unaudited. Reaching a clean all-provider comparison across 100 tasks is gated on closing the per-provider blockers below, not on the run mechanics.

### Blockers

provider | blocker | durable fix
--- | --- | ---
Vercel | Per-task Docker fidelity. The fallback Python runtime needs system/pip deps that the per-task Docker image would supply (e.g. `_sqlite3`, `torch`, CLI entrypoints). Today these are patched by a narrow, hand-maintained repo→deps mapping in `ts/src/bench.ts`, which does not scale to 100 distinct repos. | A Vercel-compatible prebuilt runtime or snapshot derived from each SWE-Smith Docker setup, so deps are not repaired per repo at run time.
Modal | Non-deterministic gold-patch application (patch rejects on some tasks), which makes a solver/patch problem look provider-related. | Deterministic patch application before the run is scored.
Daytona | Resource/concurrency limits and occasional per-repo image fidelity (e.g. fvcore). | Concurrency tuned to account limits; task-compatible image setup for the failing repos.
All | 80 of 100 tasks are unaudited. | Run the full set and triage failures into "provider fidelity gap" vs "solver/patch failure" vs "real task failure".

### Run Mechanics

Producing the data for 100 tasks is mechanical — it does not by itself close the gaps above. Select the full set with `--task-index all --task-limit 100` and cap per-provider task concurrency, since SWE-Smith Docker-image tasks force Vercel and Modal to one task at a time:

```bash
bun --env-file=.env ts/src/matrix.ts \
  --providers all --modes cold,warm \
  --task-index all --task-limit 100 \
  --vercel-concurrency 1 --modal-concurrency 1 --daytona-concurrency 2 \
  --run-concurrency 6 \
  --timeout-seconds 900 --solve-timeout-seconds 600 \
  --solve-command-file scripts/openrouter_solver.sh \
  --output results/solve-price-matrix-task100.json
```

The matrix runner already applies provider-specific concurrency caps for Docker-image datasets (Vercel and Modal default to 1), so the explicit `--*-concurrency` flags above are for tuning, not correctness. Expect wall-clock on the order of hours; raise Daytona concurrency only as far as account CPU/memory limits allow.
