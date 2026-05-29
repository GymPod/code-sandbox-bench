#!/usr/bin/env python3
"""Extract a deterministic smoke subset from a Harbor parquet dataset.

The harness consumes JSONL rows with top-level task_id, prompt, instruction,
and task_files fields. Harbor parquet rows keep those fields nested in
metadata.instance, so this script writes both:

- a parquet subset preserving the original rows
- a JSONL mirror in the harness format
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--count", default=100, type=int)
    parser.add_argument("--strategy", choices=["first", "even"], default="even")
    parser.add_argument("--output-parquet", required=True, type=Path)
    parser.add_argument("--output-jsonl", required=True, type=Path)
    return parser.parse_args()


def sample_indices(total: int, count: int, strategy: str) -> list[int]:
    count = min(count, total)
    if strategy == "first":
        return list(range(count))
    if count == 1:
        return [0]
    return sorted({round(index * (total - 1) / (count - 1)) for index in range(count)})


def normalize_task(row: dict) -> dict:
    metadata = row["metadata"]
    if isinstance(metadata, str):
        metadata = json.loads(metadata)
    instance = metadata["instance"]
    if isinstance(instance, str):
        instance = json.loads(instance)
    task_files = instance["task_files"]
    if isinstance(task_files, str):
        task_files = json.loads(task_files)
    instruction = instance.get("instruction") or row.get("prompt") or ""
    return {
        "task_id": instance["task_id"],
        "prompt": row.get("prompt") or instruction,
        "instruction": instruction,
        "task_files": task_files,
        "data_source": metadata.get("data_source"),
        "env_type": metadata.get("env_type"),
    }


def main() -> None:
    args = parse_args()
    parquet = pq.ParquetFile(args.input)
    indices = sample_indices(parquet.metadata.num_rows, args.count, args.strategy)

    tables = [parquet.read_row_group(index) for index in indices]
    subset = pa.concat_tables(tables)

    args.output_parquet.parent.mkdir(parents=True, exist_ok=True)
    args.output_jsonl.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(subset, args.output_parquet)

    with args.output_jsonl.open("w", encoding="utf-8") as output:
        for row in subset.to_pylist():
            output.write(json.dumps(normalize_task(row), separators=(",", ":")) + "\n")

    print(
        json.dumps(
            {
                "input": str(args.input),
                "rows_available": parquet.metadata.num_rows,
                "rows_written": len(indices),
                "strategy": args.strategy,
                "output_parquet": str(args.output_parquet),
                "output_jsonl": str(args.output_jsonl),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
