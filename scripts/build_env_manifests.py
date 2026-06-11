#!/usr/bin/env python3
"""Build per-repo environment manifests for SWE-Smith datasets.

SWE-Smith task Docker images are built from per-repo profiles in the
``swesmith`` package (python version + install commands). Providers that can
run the task Docker image directly (Modal, Daytona) do not need this file.
Providers that cannot (Vercel, local) previously relied on a hand-maintained
repo->deps mapping in ts/src/bench.ts, which does not scale past a handful of
repos. This script derives one manifest entry per repo in the dataset straight
from the swesmith profiles, merged with narrow overrides from
data/swesmith_env_overrides.json, and writes data/swesmith_env_manifests.json
for the TypeScript runner.

Usage:
  python3 scripts/build_env_manifests.py \
    --dataset data/swesmith_v4_smoke100.jsonl \
    --output data/swesmith_env_manifests.json

The swesmith source is downloaded from PyPI by default (sdist/wheel only, no
install) so the manifest always reflects the same profile definitions the task
images were built from. Pass --swesmith-src to use a local checkout instead.
"""

from __future__ import annotations

import argparse
import ast
import base64
import gzip
import io
import json
import re
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

SWESMITH_VERSION = "0.0.6"
PYTHON_PROFILE_DEFAULTS = {
    "python_version": "3.10",
    "install_cmds": ["python -m pip install -e ."],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parent.parent
    parser.add_argument("--dataset", action="append", default=None,
                        help="dataset jsonl path(s); default data/swesmith_v4_smoke100.jsonl")
    parser.add_argument("--overrides", default=str(root / "data/swesmith_env_overrides.json"))
    parser.add_argument("--output", default=str(root / "data/swesmith_env_manifests.json"))
    parser.add_argument("--swesmith-version", default=SWESMITH_VERSION)
    parser.add_argument("--swesmith-src", default=None,
                        help="path to an unpacked swesmith source tree (skips PyPI download)")
    args = parser.parse_args()
    if not args.dataset:
        args.dataset = [str(root / "data/swesmith_v4_smoke100.jsonl")]
    return args


def fetch_swesmith_profiles_source(version: str) -> str:
    """Download the swesmith wheel from PyPI and return profiles/python.py text."""
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            [sys.executable, "-m", "pip", "download", f"swesmith=={version}",
             "--no-deps", "--quiet", "-d", tmp],
            check=True,
        )
        wheels = list(Path(tmp).glob("swesmith-*.whl"))
        if not wheels:
            raise FileNotFoundError("swesmith wheel not downloaded")
        with zipfile.ZipFile(wheels[0]) as wheel:
            return wheel.read("swesmith/profiles/python.py").decode("utf-8")


def literal_from_field_call(node: ast.expr) -> object | None:
    """Extract the literal default from `field(default_factory=lambda: <literal>)`."""
    if not (isinstance(node, ast.Call) and getattr(node.func, "id", None) == "field"):
        return None
    for keyword in node.keywords:
        if keyword.arg == "default_factory" and isinstance(keyword.value, ast.Lambda):
            try:
                return ast.literal_eval(keyword.value.body)
            except ValueError:
                return None
    return None


def parse_python_profiles(source: str) -> dict[str, dict]:
    """Parse swesmith/profiles/python.py into {repo_key: profile_fields}."""
    module = ast.parse(source)
    profiles: dict[str, dict] = {}
    for node in module.body:
        if not isinstance(node, ast.ClassDef):
            continue
        bases = {getattr(base, "id", None) for base in node.bases}
        if "PythonProfile" not in bases:
            continue
        fields: dict[str, object] = {}
        for statement in node.body:
            if not isinstance(statement, ast.AnnAssign) or statement.value is None:
                continue
            name = getattr(statement.target, "id", None)
            if name is None:
                continue
            try:
                fields[name] = ast.literal_eval(statement.value)
                continue
            except ValueError:
                pass
            literal = literal_from_field_call(statement.value)
            if literal is not None:
                fields[name] = literal
        owner, repo, commit = fields.get("owner"), fields.get("repo"), fields.get("commit")
        if not (isinstance(owner, str) and isinstance(repo, str) and isinstance(commit, str)):
            continue
        repo_key = f"{owner}__{repo}.{commit[:8]}"
        profiles[repo_key] = {
            "class_name": node.name,
            "owner": owner,
            "repo": repo,
            "commit": commit,
            "python_version": fields.get("python_version", PYTHON_PROFILE_DEFAULTS["python_version"]),
            "install_cmds": fields.get("install_cmds", PYTHON_PROFILE_DEFAULTS["install_cmds"]),
        }
    return profiles


def dataset_repos(paths: list[str]) -> dict[str, dict]:
    """Extract {repo_key: {docker_image, task_count}} from dataset jsonl files."""
    repos: dict[str, dict] = {}
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                task = json.loads(line)
                if task.get("env_type") != "harbor_swesmith":
                    continue
                archive = tarfile.open(fileobj=io.BytesIO(
                    gzip.decompress(base64.b64decode(task["task_files"]["content"]))))
                toml_text = read_member(archive, "task.toml")
                dockerfile = read_member(archive, "environment/Dockerfile")
                repo_match = re.search(r'^repository = "([^"]+)"', toml_text, re.M)
                if not repo_match:
                    raise ValueError(f"task {task['task_id']} has no repository in task.toml")
                repo_key = repo_match.group(1).split("/", 1)[-1]
                image = next(
                    (l.split()[1] for l in dockerfile.splitlines() if l.startswith("FROM ")),
                    None,
                )
                entry = repos.setdefault(repo_key, {"docker_image": image, "task_count": 0})
                entry["task_count"] += 1
    return repos


def read_member(archive: tarfile.TarFile, name: str) -> str:
    member = archive.extractfile(name)
    if member is None:
        raise FileNotFoundError(name)
    return member.read().decode("utf-8")


def main() -> None:
    args = parse_args()
    if args.swesmith_src:
        source = (Path(args.swesmith_src) / "swesmith/profiles/python.py").read_text()
    else:
        source = fetch_swesmith_profiles_source(args.swesmith_version)
    profiles = parse_python_profiles(source)
    repos = dataset_repos(args.dataset)

    overrides: dict[str, dict] = {}
    overrides_path = Path(args.overrides)
    if overrides_path.exists():
        overrides = json.loads(overrides_path.read_text())

    missing = sorted(key for key in repos if key not in profiles)
    if missing:
        raise SystemExit(f"no swesmith profile for dataset repos: {missing}")

    manifest_repos: dict[str, dict] = {}
    for repo_key in sorted(repos):
        profile = profiles[repo_key]
        override = overrides.get(repo_key, {})
        entry = {
            "owner": profile["owner"],
            "repo": profile["repo"],
            "commit": profile["commit"],
            "mirror": f"swesmith/{repo_key}",
            "docker_image": repos[repo_key]["docker_image"],
            "task_count": repos[repo_key]["task_count"],
            "python_version": str(profile["python_version"]),
            "install_cmds": override.get("install_cmds", profile["install_cmds"]),
            "pre_install_pip": override.get("pre_install_pip", []),
            "extra_pip": override.get("extra_pip", []),
            "system_packages": override.get("system_packages", []),
        }
        if "resources" in override:
            entry["resources"] = override["resources"]
        if "notes" in override:
            entry["notes"] = override["notes"]
        manifest_repos[repo_key] = entry

    unknown_overrides = sorted(key for key in overrides if key not in repos)
    if unknown_overrides:
        print(f"warning: overrides for repos not in dataset: {unknown_overrides}", file=sys.stderr)

    output = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "swesmith_version": args.swesmith_version,
        "datasets": args.dataset,
        "repo_count": len(manifest_repos),
        "repos": manifest_repos,
    }
    Path(args.output).write_text(json.dumps(output, indent=2) + "\n")
    print(f"wrote {len(manifest_repos)} repo manifests to {args.output}")


if __name__ == "__main__":
    main()
