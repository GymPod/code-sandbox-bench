# Data

Bundled benchmark task datasets.

## Files

- `terminalbench_2026_03_05_smoke16.parquet`: TerminalBench smoke set.
- `terminalbench_2026_03_05_smoke16.jsonl`: JSONL mirror for runtimes that do not need parquet parsing.
- `swesmith_v4_smoke100.parquet`: 100-task SWE-Smith smoke sample.
- `swesmith_v4_smoke100.jsonl`: JSONL mirror used by the TypeScript runner by default.

The JSONL mirrors preserve the task id, prompt, instruction, task archive, data source, and task environment metadata needed by the runners.

## SWE-Smith Layout

SWE-Smith task archives include:

- `tests/test.sh`: verifier entrypoint when present.
- `solution/*`: reference solution artifacts used by gold-solver experiments.
- `environment/Dockerfile`: task runtime definition.
- `environment/hackblock/*`: helper files used by task Docker setup.

The runner maps SWE-Smith tasks to `/testbed`. Modal and Daytona can use the task Docker image or Dockerfile setup. Vercel and local reconstruct the environment from the per-repo manifests described below.

## Environment Manifests

- `swesmith_env_manifests.json`: generated, one entry per repo in the SWE-Smith dataset. Each entry records the mirror repo, the exact Python version, the install commands from the SWE-Smith profile the task Docker image was built from, plus any extra pip/system deps and resource overrides. The TypeScript runner uses this to reconstruct task environments on providers that cannot run the task Docker image.
- `swesmith_env_overrides.json`: hand-maintained, narrow per-repo overrides merged into the generated manifest (e.g. CPU torch wheel index for fvcore/MONAI, pandas source-build requirements, higher memory/disk for heavy repos).

Regenerate after dataset or override changes:

```bash
python3 scripts/build_env_manifests.py
```

The script downloads the pinned `swesmith` package from PyPI and parses its per-repo profiles, so the manifest always reflects the same recipes the task images were built from. It fails if any dataset repo has no profile.

## Regeneration

The SWE-Smith smoke set was created from a local parquet source with:

```bash
python scripts/extract_harbor_smoke.py --input ~/Downloads/swesmith-v4_train_2026_05_15.parquet --count 100 --strategy even --output-parquet data/swesmith_v4_smoke100.parquet --output-jsonl data/swesmith_v4_smoke100.jsonl
```

Do not regenerate these files casually; result artifacts and reports refer to exact task ordering.
