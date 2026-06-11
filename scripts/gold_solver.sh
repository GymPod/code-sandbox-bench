#!/bin/bash
# Gold-patch solver for runnability verification. The harness rewrites
# /solution/solve.sh into a deterministic, idempotent form during prepare
# (see ts/src/bench.ts), so this simply runs it. Use with:
#   --solve-command-file scripts/gold_solver.sh
# to check that every task environment can apply the reference solution and
# pass its verifier on a given provider, independent of any LLM solver.
set -eu
bash /solution/solve.sh
