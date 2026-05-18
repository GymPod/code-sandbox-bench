# TerminalBench Provider Harness Report

## Scope

This report covers the lightweight dogfood terminal harness and the 16-row TerminalBench smoke benchmark added in PR 1705. The harness supports:

- `local` execution for toy terminal repair tasks.
- `vercel` / `vercel_sandbox` for toy tasks and TerminalBench smoke verifier runs.
- `modal` and `daytona` in the verifier-only cold vs prepared-snapshot benchmark CLI.

The benchmark is intentionally verifier-only. It prepares a task workspace and runs `bash /tests/test.sh`, but it does not run a solver/model edit step. A `0/16` pass count is therefore expected for the 16 TerminalBench runs.

## How The Tests Work

### Toy Harness Smoke

Command shape:

```bash
PYTHONPATH=$(pwd) python -m autonomy.dogfood.terminal_harness --provider vercel --runtime python --task-source toy --timeout-seconds 120
```

This runs a tiny terminal-style repair task through the OpenRouter-compatible agent path. The agent receives a shell tool backed by the selected provider. For Vercel, the harness starts a sandbox, runs the agent's tool calls inside it, and then executes the verifier in the same sandbox.

Observed result:

| Test | Provider | Result |
| --- | --- | --- |
| Toy Python repair | Vercel Sandbox | Passed |

### TerminalBench Smoke Benchmark

Command used for the completed 16-task Vercel run:

```bash
PYTHONPATH=$(pwd) python -m autonomy.dogfood.vercel_terminalbench_benchmark --task-index all --timeout-seconds 180 --output /tmp/vercel-terminalbench-benchmark-all16.json
```

For each selected TerminalBench row, the benchmark runs three phases:

| Phase | What It Does |
| --- | --- |
| Cold prepare + verifier | Starts a fresh provider sandbox, uploads the task workspace and tests, installs `pytest`, then runs `bash /tests/test.sh`. |
| Snapshot prepare | Starts or builds a prepared environment with the task workspace and tests, then snapshots it. |
| Warm verifier | Starts from the prepared snapshot and runs only `bash /tests/test.sh`. |

Provider-specific snapshot behavior:

| Provider | Snapshot Method |
| --- | --- |
| Vercel | Prepare a running Vercel sandbox, then call the Vercel snapshot API and restart from the returned snapshot ID. |
| Modal | Prepare a running Modal sandbox, then snapshot its filesystem as a Modal image and restart from that image ID. |
| Daytona | Build a named Daytona snapshot from an image spec that includes the task workspace, tests, and verifier dependencies. |

### Local Verification

The following local checks ran against the original slime PR implementation:

| Check | Result | Notes |
| --- | --- | --- |
| `py_compile` on changed harness/provider/test files | Passed | Validates syntax/importability for the changed files. |
| Focused pytest suite | Passed | `39 passed, 6 skipped, 1 warning`; skipped tests are Daytona live-provider tests without credentials. |
| Pre-commit on changed files | Passed | Black, isort, ruff, autoflake, and repository file checks passed. |
| Benchmark CLI help smoke | Passed | Confirms `--provider {vercel,vercel_sandbox,modal,daytona}` is exposed. |
| Vercel one-task benchmark regression | Passed | Exercised the generalized provider benchmark path and cleaned up the Vercel snapshot. |
| `make typecheck` | Failed baseline | Repo-wide mypy backlog: `1719 errors in 182 files`. |
| `make test` | Failed baseline | Repo-wide failures: `48 failed, 1041 passed, 12 skipped, 192 errors`. |

The standalone TypeScript harness was later run against Vercel, Modal, and Daytona from `code-sandbox-bench`.

## Actual Vercel 16-Task Result

| Mode | Passed | Estimated Upper-Bound Cost |
| --- | ---: | ---: |
| Cold prepare + verifier | 0/16 | $0.023947 |
| Warm verifier from prepared snapshots | 0/16 | $0.009132 |
| Snapshot prepare + warm verifier | 0/16 | $0.041493 |

Interpretation:

- Warm-only was cheaper than cold by about `$0.014815` for this run.
- Including snapshot preparation made the one-shot warm path more expensive than cold by about `$0.017546`.
- The run left no active Vercel sandboxes or retained Vercel snapshots after cleanup.

## Actual Standalone TypeScript Results

These runs used the standalone `ts/` harness against the bundled JSONL mirror of the 16-row TerminalBench smoke set. They are cold verifier-only runs: each task starts a sandbox, uploads/extracts task files, installs `pytest`, runs the verifier, records output tails, then stops or deletes the sandbox. They do not run a solver/model step, so `0/16` pass counts are expected.

Commands:

```bash
cd ts && bun run bench --provider vercel --task-index all --runtime python3.13 --timeout-seconds 180 --concurrency 4 --output ../results/ts-vercel-sdk-all.json
```

```bash
cd ts && bun run bench --provider modal --task-index all --runtime python:3.13 --timeout-seconds 180 --concurrency 4 --output ../results/ts-modal-all.json
```

```bash
cd ts && bun run bench --provider daytona --task-index all --runtime python:3.13 --timeout-seconds 180 --concurrency 2 --output ../results/ts-daytona-all.json
```

Daytona was run with concurrency 2 because the account currently has a 10 GiB total memory limit and the default harness request is 4 GiB per sandbox. A previous concurrency-4 attempt was rejected by Daytona before completion; the two sandboxes created before that rejection were deleted.

| Provider | SDK/Runtime | Concurrency | Passed | Total Wall Seconds | Avg Seconds / Task | Estimated Cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Vercel Sandbox | `@vercel/sandbox`, `python3.13` | 4 | 0/16 | 111.12 | 6.94 | $0.010529 |
| Modal | `modal`, `python:3.13` | 4 | 0/16 | 130.75 | 8.17 | $0.008669 |
| Daytona | `@daytona/sdk`, `python:3.13` | 2 | 0/16 | 86.66 | 5.42 | $0.003999 |

Cleanup checks:

| Provider | Cleanup Result |
| --- | --- |
| Vercel Sandbox | `sandbox list` showed no active sandboxes after the SDK all-16 run. |
| Daytona | Daytona SDK `list()` returned an empty sandbox list after the all-16 run. |
| Modal | Each task calls `Sandbox.terminate()` in the provider `finally` path. |

## Vendor Pricing Model

Pricing was checked against public vendor pages on May 18, 2026.

| Provider | Rates Used In Benchmark |
| --- | --- |
| Vercel Sandbox | Active CPU `$0.128/vCPU-hour`, memory `$0.0212/GB-hour`, creation `$0.60/1M`, storage `$0.08/GB-month` from [Vercel pricing](https://vercel.com/pricing). |
| Modal Sandbox + Notebooks | CPU `$0.00003942/physical-core-second`, memory `$0.00000672/GiB-second`; Modal states one physical core is 2 vCPU equivalent on [Modal pricing](https://modal.com/pricing). |
| Daytona | CPU `$0.00001400/vCPU-second`, memory `$0.00000450/GiB-second`, storage `$0.00000003/GiB-second` after 5 GB free from [Daytona pricing](https://www.daytona.io/pricing). |

Important assumptions:

- The harness records wall-clock phase duration and treats it as an upper bound for active CPU.
- Vercel bills active CPU separately from provisioned memory; the benchmark cannot see exact active CPU seconds from the CLI.
- Modal uses physical cores. The comparison maps `2 vCPU` to `1 physical core`.
- Daytona storage estimate assumes `10 GiB` disk with `5 GiB` billable after the free allowance.
- Network, snapshot storage retention beyond the run, provider credits, region multipliers, and volume discounts are excluded.

## Side-By-Side Cost Comparison

The original table below applies measured Vercel phase durations from the slime PR benchmark to each vendor's public rates. This remains a normalized cold/warm/snapshot model. The standalone TypeScript table above is the live side-by-side cold verifier measurement across all three providers.

Measured aggregate phase durations inferred from the completed Vercel benchmark:

| Phase | Total Seconds | Avg Seconds / Task |
| --- | ---: | ---: |
| Cold prepare + verifier | 252.86 | 15.80 |
| Warm verifier | 96.36 | 6.02 |
| Snapshot prepare | 341.74 | 21.36 |

Normalized cost estimate for all 16 tasks:

| Provider | Cold | Warm Only | Snapshot Prepare | Snapshot Prepare + Warm |
| --- | ---: | ---: | ---: | ---: |
| Vercel Sandbox | $0.023947 | $0.009132 | $0.032361 | $0.041493 |
| Modal | $0.016765 | $0.006389 | $0.022657 | $0.029046 |
| Daytona | $0.011669 | $0.004447 | $0.015771 | $0.020218 |

Updated takeaways:

- On this verifier-only workload, warm starts were materially cheaper than cold runs in the original Vercel snapshot experiment if snapshots already existed.
- Snapshot preparation dominates one-shot warm cost. Reusing snapshots across multiple verifier or solver attempts is where warm starts become useful.
- The live TypeScript cold verifier run measured Daytona as the lowest estimated cost, followed by Modal, then Vercel.
- The Vercel SDK run was materially faster and cheaper than the earlier Vercel CLI run because it avoids CLI process overhead in each command.
