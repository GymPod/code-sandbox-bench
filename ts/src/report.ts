import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type BenchResult = {
  task_id: string;
  passed: boolean;
  elapsed_seconds: number;
  estimated_cost_usd?: number;
  phases?: Record<string, number>;
  solve_elapsed_seconds?: number;
};

type BenchFile = {
  provider: string;
  runtime: string;
  task_count: number;
  solve_enabled: boolean;
  passed: number;
  estimated_cost_usd?: number;
  results: BenchResult[];
};

type RunSpec = {
  label: string;
  mode: "cold" | "warm";
  kind: "verifier" | "solve";
  path: string;
};

const RUNS: RunSpec[] = [
  { label: "Vercel cold verifier", mode: "cold", kind: "verifier", path: "results/ts-vercel-cold-verifier-all-20260528.json" },
  { label: "Vercel warm verifier", mode: "warm", kind: "verifier", path: "results/ts-vercel-warm-verifier-all-20260528.json" },
  { label: "Modal cold verifier", mode: "cold", kind: "verifier", path: "results/ts-modal-cold-verifier-all-20260528.json" },
  { label: "Modal warm verifier", mode: "warm", kind: "verifier", path: "results/ts-modal-warm-verifier-all-20260528.json" },
  { label: "Daytona cold verifier", mode: "cold", kind: "verifier", path: "results/ts-daytona-cold-verifier-all-20260528.json" },
  { label: "Daytona warm verifier", mode: "warm", kind: "verifier", path: "results/ts-daytona-warm-verifier-all-20260528.json" },
  { label: "Vercel warm solve", mode: "warm", kind: "solve", path: "results/ts-vercel-warm-solve-all-20260528.json" },
  { label: "Modal warm solve", mode: "warm", kind: "solve", path: "results/ts-modal-warm-solve-all-20260528.json" },
  { label: "Daytona warm solve", mode: "warm", kind: "solve", path: "results/ts-daytona-warm-solve-all-20260528.json" }
];

const PHASES = [
  "start_seconds",
  "upload_seconds",
  "prepare_seconds",
  "instruction_write_seconds",
  "solve_seconds",
  "verify_seconds",
  "stop_seconds"
];

function parseArgs(argv: string[]): { output: string } {
  const outputIndex = argv.indexOf("--output");
  return {
    output: outputIndex >= 0 ? argv[outputIndex + 1] : "reports/terminalbench_provider_report.md"
  };
}

async function loadRun(spec: RunSpec): Promise<{ spec: RunSpec; data: BenchFile }> {
  return { spec, data: await Bun.file(spec.path).json() };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function fmtSeconds(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? "-" : value.toFixed(2);
}

function fmtMoney(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? "-" : `$${value.toFixed(4)}`;
}

function phaseMean(results: BenchResult[], phase: string): number | undefined {
  const values = results.map((result) => result.phases?.[phase]).filter((value): value is number => typeof value === "number");
  return values.length === 0 ? undefined : mean(values);
}

function summaryRow(run: { spec: RunSpec; data: BenchFile }): string {
  const elapsed = run.data.results.map((result) => result.elapsed_seconds);
  return [
    run.data.provider,
    run.spec.mode,
    run.spec.kind,
    `${run.data.passed}/${run.data.task_count}`,
    fmtSeconds(sum(elapsed)),
    fmtSeconds(mean(elapsed)),
    fmtSeconds(median(elapsed)),
    fmtSeconds(percentile(elapsed, 95)),
    fmtMoney(run.data.estimated_cost_usd)
  ].join(" | ");
}

function phaseRow(run: { spec: RunSpec; data: BenchFile }): string {
  return [
    run.data.provider,
    run.spec.mode,
    run.spec.kind,
    ...PHASES.map((phase) => fmtSeconds(phaseMean(run.data.results, phase)))
  ].join(" | ");
}

function solveCell(result: BenchResult | undefined): string {
  if (!result) {
    return "-";
  }
  const status = result.passed ? "pass" : "fail";
  return `${status} ${fmtSeconds(result.elapsed_seconds)}s ${fmtMoney(result.estimated_cost_usd)}`;
}

function solveTaskRows(runs: { spec: RunSpec; data: BenchFile }[]): string[] {
  const solveRuns = runs.filter((run) => run.spec.kind === "solve");
  const taskIds = Array.from(new Set(solveRuns.flatMap((run) => run.data.results.map((result) => result.task_id)))).sort();
  return taskIds.map((taskId) => {
    const cells = solveRuns.map((run) => solveCell(run.data.results.find((result) => result.task_id === taskId)));
    return [taskId, ...cells].join(" | ");
  });
}

function missingTasks(run: { spec: RunSpec; data: BenchFile }): string {
  const failed = run.data.results.filter((result) => !result.passed).map((result) => result.task_id);
  return failed.length === 0 ? "none" : failed.join(", ");
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const runs = await Promise.all(RUNS.map(loadRun));
  const verifierRuns = runs.filter((run) => run.spec.kind === "verifier");
  const solveRuns = runs.filter((run) => run.spec.kind === "solve");
  const generatedAt = new Date().toISOString();

  const lines = [
    "# TerminalBench Sandbox Provider Report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Scope",
    "",
    "- Dataset: `data/terminalbench_2026_03_05_smoke16.jsonl` (16 tasks).",
    "- Expanded smoke dataset: `data/swesmith_v4_smoke100.jsonl` (100 evenly sampled SWE-Smith tasks from `~/Downloads/swesmith-v4_train_2026_05_15.parquet`).",
    "- Verifier-only runs cover cold and warm startup for Vercel, Modal, and Daytona.",
    "- Solve runs cover warm/snapshot startup for all three providers using `scripts/openrouter_solver.sh` with `deepseek/deepseek-v4-flash` through OpenRouter.",
    "- Vercel warm uses snapshot `snap_TkzxZLA3B7Jij3GonaqFkUFhSo2K`; Modal warm uses image `im-PN0mo0YJNhDkPn6VWNCLz4`.",
    "- Daytona named snapshot creation returned `403 Forbidden` with the current API key, so Daytona warm uses the cached `terminalbench-smoke` image definition path rather than a named snapshot.",
    "",
    "## Rollup",
    "",
    "provider | mode | kind | passed | total seconds | mean seconds | median seconds | p95 seconds | estimated provider cost",
    "--- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---:",
    ...runs.map(summaryRow),
    "",
    "## Mean Phase Seconds",
    "",
    "provider | mode | kind | start | upload | prepare | instruction write | solve | verify | stop",
    "--- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---:",
    ...runs.map(phaseRow),
    "",
    "## Warm Solve Per Task",
    "",
    "task | vercel | modal | daytona",
    "--- | --- | --- | ---",
    ...solveTaskRows(runs),
    "",
    "## Failed Warm Solve Tasks",
    "",
    ...solveRuns.map((run) => `- ${run.data.provider}: ${missingTasks(run)}`),
    "",
    "## Expanded SWE-Smith Smoke100",
    "",
    "The repository now includes a broader 100-task smoke slice:",
    "",
    "- Source parquet: `~/Downloads/swesmith-v4_train_2026_05_15.parquet`",
    "- Rows available in source: `37,497`",
    "- Rows selected: `100`",
    "- Sampling strategy: evenly spaced by row index for deterministic repository/task diversity",
    "- Output parquet: `data/swesmith_v4_smoke100.parquet`",
    "- Output JSONL: `data/swesmith_v4_smoke100.jsonl`",
    "",
    "This dataset is structurally compatible with the harness JSONL loader: each row has `task_id`, `prompt`, `instruction`, and embedded `task_files`. The SWE-Smith verifier layout differs from TerminalBench: tasks provide `tests/test.sh` and `solution/*`, and expect their Docker image to provide `/testbed`, conda, and `/opt/verifier-venv`. The TypeScript verifier path now runs `/tests/test.sh` when present, but full provider benchmarking on SWE-Smith still needs per-task Dockerfile/image support instead of the generic `python:3.13` runtime.",
    "",
    "## Raw Artifacts",
    "",
    ...RUNS.map((run) => `- ${run.label}: \`${run.path}\``),
    "- Vercel prewarm: `results/prewarm-vercel-terminalbench-20260528.json`",
    "- Modal prewarm: `results/prewarm-modal-terminalbench-20260528.json`",
    "",
    "## Notes",
    "",
    "- Verifier-only runs are expected to fail task tests because they only unpack and verify the initial task state. They are useful for launch/setup/upload/verify latency and provider cost.",
    "- Cost estimates are harness estimates based on configured provider rates and measured elapsed time; they do not include OpenRouter model spend.",
    "- The OpenRouter solver is intentionally simple and stores only output tails. Its pass rate is a sandbox-plus-solver smoke signal, not a benchmark of maximum attainable task accuracy."
  ];

  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${lines.join("\n")}\n`);
  console.log(`wrote ${args.output}`);
}

await main();
