# Python Runner

Python implementation of the benchmark runner and provider adapters.

The TypeScript runner is the current primary path for matrix runs and report generation, but the Python runner remains useful for local smoke checks and provider-adapter experiments.

## Install

```bash
uv venv
source .venv/bin/activate
uv pip install -e ".[providers]"
```

## Run One Local Task

```bash
python -m code_sandbox_bench.bench --provider local --task-index 0 --output ../results/local-one.json
```

## Run A Provider

```bash
python -m code_sandbox_bench.bench --provider vercel --task-index all --output ../results/vercel-all.json
python -m code_sandbox_bench.bench --provider modal --task-index all --output ../results/modal-all.json
python -m code_sandbox_bench.bench --provider daytona --task-index all --output ../results/daytona-all.json
```

## Notes

- The Python runner supports `local`, `vercel`, `modal`, and `daytona`.
- Provider credentials are read from the environment.
- New cross-provider analysis should generally use the TypeScript matrix runner so output shape matches the current reports.

## Reports

The Python runner writes the same result JSON shape as the TypeScript runner, so its outputs can feed the shared report generator — but the generator's discovery logic only picks up files named `ts-<provider>-<mode>-solve-all*.json`, so Python outputs must follow that naming to be included. The current reports were generated from TypeScript matrix runs; see the Reporting section of the root README for the full pipeline.
