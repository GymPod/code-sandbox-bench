# AWS Lambda MicroVM Provider

## Configuration

Implementation:

- `AwsMicrovmProvider` in `ts/src/providers.ts`
- `AwsMicrovmSandbox` in `ts/src/aws_microvm.ts`
- runner image artifact in `ts/aws-microvm-runner/`

Required inputs:

- `AWS_REGION`, defaulting to `us-east-1`
- `AWS_MICROVM_IMAGE_ID` or `--aws-microvm-image-id`
- `AWS_MICROVM_IMAGE_VERSION` or `--aws-microvm-image-version`, optional but recommended for repeatability
- `AWS_MICROVM_ARTIFACT_BUCKET` and `AWS_MICROVM_BUILD_ROLE_ARN` for `bun run prewarm --provider aws-microvm`

Useful runtime controls:

- `AWS_MICROVM_MAX_DURATION_SECONDS`, defaulting to `timeoutSeconds + 180` with a 3600s cap
- `AWS_MICROVM_MAX_IDLE_DURATION_SECONDS`, default `120`
- `AWS_MICROVM_SUSPENDED_DURATION_SECONDS`, default `0`
- `AWS_MICROVM_AUTO_RESUME`, default `false`
- `AWS_MICROVM_MAX_CONCURRENCY`, default `4` in `bench.ts`
- `AWS_MICROVM_INGRESS_CONNECTORS`, default `ALL_INGRESS`
- `AWS_MICROVM_EGRESS_CONNECTORS`, default `INTERNET_EGRESS`

## Image Creation

Create the reusable runner image with:

```bash
cd ts
bun run prewarm \
  --provider aws-microvm \
  --name code-sandbox-bench-runner-YYYYMMDD \
  --timeout-seconds 900 \
  --memory-gb 2 \
  --aws-region us-east-1 \
  --aws-bucket <artifact-bucket> \
  --aws-build-role-arn <build-role-arn> \
  --output ../results/prewarm-aws-microvm.json
```

The prewarm script packages `ts/aws-microvm-runner/`, uploads it to S3, calls `CreateMicrovmImage`, waits for `CREATED`, and emits:

```text
AWS_REGION=...
AWS_MICROVM_IMAGE_ID=...
AWS_MICROVM_IMAGE_VERSION=...
```

Lifecycle hooks are disabled by default for the MVP image. Set `AWS_MICROVM_ENABLE_HOOKS=1` to include `/ready`, `/validate`, `/run`, `/resume`, and `/terminate` hooks exposed by the runner.

## Command Invocation

The MicroVM image runs a Python HTTP command runner on port `8080`.

`AwsMicrovmSandbox.start()`:

1. Calls `RunMicrovm`.
2. Creates a port-scoped auth token with `CreateMicrovmAuthToken`.
3. Polls `/health` through the MicroVM HTTPS endpoint.

`run(command, cwd, timeoutSeconds)` uses asynchronous command jobs:

1. `POST /commands` with `{ command, cwd, timeoutSeconds }`.
2. Poll `GET /commands/<jobId>` until `status == "completed"`.
3. Return `{ stdout, stderr, returnCode }`.

The async job shape avoids holding a single HTTPS request open for long dependency installs.

## Task Environments

TerminalBench tasks run in `/workspace`. The shared harness extracts the task archive, copies tests to `/tests`, and runs the verifier.

SWE-Smith tasks currently use the Vercel-style manifest reconstruction path because the AWS MicroVM provider does not consume each task Docker image directly. The first SWE-Smith smoke attempt reached the long prepare phase but still hit a `502` while the tiny runner image was repairing the repo environment. Treat SWE-Smith support as the next hardening target.

## Cold And Warm Behavior

AWS MicroVMs always launch a fresh MicroVM per task from a prebuilt MicroVM image. In this harness:

- `cold` means a new MicroVM instance from the configured image.
- `warm` reuses the same `AWS_MICROVM_IMAGE_ID` / version artifact across runs, but still launches isolated per-task MicroVMs.

This shape parallelizes cleanly: build one image, then run N task MicroVMs with the same environment config and bounded `AWS_MICROVM_MAX_CONCURRENCY`.

## MVP Evidence

The first passing proof used:

```bash
AWS_REGION=us-east-1 AWS_MICROVM_MAX_DURATION_SECONDS=600 \
bun src/bench.ts \
  --provider aws-microvm \
  --mode cold \
  --dataset ../data/terminalbench_2026_03_05_smoke16.jsonl \
  --task-index 4 \
  --timeout-seconds 300 \
  --solve-timeout-seconds 120 \
  --concurrency 1 \
  --memory-gb 2 \
  --cpu 2 \
  --aws-microvm-image-id arn:aws:lambda:us-east-1:172630973301:microvm-image:code-sandbox-bench-runner-20260624 \
  --aws-microvm-image-version 1.0 \
  --solve-command '<deterministic task-4 results.json writer>' \
  --output ../results/ts-aws-microvm-cold-terminalbench-task4.json
```

Result:

- task `a_b_testing_models_medium`
- passed `1/1`
- elapsed `36.08s`
- start `2.83s`
- prepare `20.22s`
- solve `2.22s`
- verify `2.42s`
- stop `0.15s`

After the run, `ListMicrovms` showed all proof MicroVMs in `TERMINATED` state and the reusable image in `CREATED` state.

## Cost Guardrails

The provider sets short task-level maximum duration and immediate termination in `stop()`. For live sweeps:

- Keep `AWS_MICROVM_MAX_CONCURRENCY` low until account quotas and pricing are confirmed.
- Use one prebuilt image for a whole run instead of rebuilding per task.
- Prefer `AWS_MICROVM_SUSPENDED_DURATION_SECONDS=0` for benchmark tasks so idle MicroVMs terminate rather than persist.
- The harness reports AWS MicroVM estimated cost only when `AWS_MICROVM_ESTIMATE_VCPU_HOUR_USD` and `AWS_MICROVM_ESTIMATE_GB_HOUR_USD` are supplied, because the public pricing page did not expose MicroVM-specific rates during this implementation pass.
