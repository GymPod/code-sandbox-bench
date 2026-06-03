import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ProviderName, RunKind, RunMode } from "./types";

type ReportProvider = Exclude<ProviderName, "local">;

type BenchResult = {
  task_id: string;
  env_type?: string;
  passed: boolean;
  elapsed_seconds: number;
  phases?: Record<string, number>;
  stderr_tail?: string;
  solve_stderr_tail?: string;
};

type BenchFile = {
  provider: ReportProvider;
  mode?: RunMode;
  kind?: RunKind;
  dataset?: string;
  runtime: string;
  task_env_counts?: Record<string, number>;
  task_count: number;
  solve_enabled: boolean;
  passed: number;
  estimated_cost_usd?: number;
  results: BenchResult[];
};

type RunSpec = {
  provider: ReportProvider;
  mode: RunMode;
  kind: "solve";
  path: string;
};

type LoadedRun = {
  spec: RunSpec;
  data: BenchFile;
};

const PROVIDERS: ReportProvider[] = ["vercel", "modal", "daytona"];
const MODES: RunMode[] = ["cold", "warm"];
const PHASES = [
  "start_seconds",
  "upload_seconds",
  "prepare_seconds",
  "instruction_write_seconds",
  "solve_seconds",
  "verify_seconds",
  "stop_seconds"
];

function parseArgs(argv: string[]): { output: string; resultsDir: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  return {
    output: values.get("--output") ?? "reports/terminalbench_provider_report.md",
    resultsDir: values.get("--results-dir") ?? "results"
  };
}

function discoverRuns(resultsDir: string): { specs: RunSpec[]; missing: RunSpec[] } {
  const files = existsSync(resultsDir) ? readdirSync(resultsDir) : [];
  const specs: RunSpec[] = [];
  const missing: RunSpec[] = [];
  for (const provider of PROVIDERS) {
    for (const mode of MODES) {
      const match = latestMatchingFile(files, provider, mode);
      const fallback = join(resultsDir, `ts-${provider}-${mode}-solve-all.json`);
      const spec = { provider, mode, kind: "solve" as const, path: match ? join(resultsDir, match) : fallback };
      if (match || existsSync(fallback)) {
        specs.push(spec);
      } else {
        missing.push(spec);
      }
    }
  }
  return { specs, missing };
}

function latestMatchingFile(files: string[], provider: ReportProvider, mode: RunMode): string | undefined {
  const prefix = `ts-${provider}-${mode}-solve-all`;
  return files
    .filter((file) => file === `${prefix}.json` || new RegExp(`^${prefix}-\\d{8}\\.json$`).test(file))
    .sort()
    .at(-1);
}

async function loadRun(spec: RunSpec): Promise<LoadedRun> {
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

function fmtDelta(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(4)}`;
}

function phaseMean(results: BenchResult[], phase: string): number | undefined {
  const values = results.map((result) => result.phases?.[phase]).filter((value): value is number => typeof value === "number");
  return values.length === 0 ? undefined : mean(values);
}

function summaryRow(run: LoadedRun): string {
  const elapsed = run.data.results.map((result) => result.elapsed_seconds);
  return [
    run.data.provider,
    run.spec.mode,
    `${run.data.passed}/${run.data.task_count}`,
    fmtSeconds(sum(elapsed)),
    fmtSeconds(mean(elapsed)),
    fmtSeconds(median(elapsed)),
    fmtSeconds(percentile(elapsed, 95)),
    fmtMoney(run.data.estimated_cost_usd)
  ].join(" | ");
}

function priceRow(provider: ReportProvider, runs: LoadedRun[]): string {
  const cold = runs.find((run) => run.spec.provider === provider && run.spec.mode === "cold")?.data.estimated_cost_usd;
  const warm = runs.find((run) => run.spec.provider === provider && run.spec.mode === "warm")?.data.estimated_cost_usd;
  const delta = cold !== undefined && warm !== undefined ? warm - cold : undefined;
  const ratio = cold && warm !== undefined ? warm / cold : undefined;
  return [provider, fmtMoney(cold), fmtMoney(warm), fmtDelta(delta), ratio === undefined ? "-" : ratio.toFixed(2)].join(" | ");
}

function phaseRow(run: LoadedRun): string {
  return [
    run.data.provider,
    run.spec.mode,
    ...PHASES.map((phase) => fmtSeconds(phaseMean(run.data.results, phase)))
  ].join(" | ");
}

function taskCell(result: BenchResult | undefined): string {
  if (!result) {
    return "-";
  }
  const status = result.passed ? "pass" : "fail";
  return `${status} ${fmtSeconds(result.elapsed_seconds)}s`;
}

function taskRows(runs: LoadedRun[]): string[] {
  const taskIds = Array.from(new Set(runs.flatMap((run) => run.data.results.map((result) => result.task_id)))).sort();
  return taskIds.map((taskId) => {
    const cells = runs.map((run) => taskCell(run.data.results.find((result) => result.task_id === taskId)));
    return [taskId, ...cells].join(" | ");
  });
}

function missingTasks(run: LoadedRun): string {
  const failed = run.data.results.filter((result) => !result.passed).map((result) => result.task_id);
  return failed.length === 0 ? "none" : failed.join(", ");
}

function failureClass(result: BenchResult): string {
  const stderr = `${result.stderr_tail ?? ""}\n${result.solve_stderr_tail ?? ""}`;
  if (stderr.includes("Total CPU limit exceeded")) {
    return "daytona CPU limit";
  }
  if (stderr.includes("Total memory limit exceeded")) {
    return "daytona memory limit";
  }
  if (stderr.includes("Sandbox creation rate limit")) {
    return "modal sandbox creation rate";
  }
  if (stderr.includes("Modal Sandbox") && stderr.includes("not found")) {
    return "modal sandbox shutdown";
  }
  if (stderr.includes("conda: command not found") || stderr.includes("/opt/verifier-venv")) {
    return "missing SWE-Smith verifier env";
  }
  if (stderr.includes("syntax error") && (stderr.includes("<bash>") || stderr.includes("<thought>"))) {
    return "solver markup output";
  }
  return "other";
}

function failureRow(run: LoadedRun): string {
  const counts = new Map<string, number>();
  for (const result of run.data.results.filter((item) => !item.passed)) {
    const key = failureClass(result);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => `${key}: ${count}`)
    .join("; ");
  return [run.data.provider, run.spec.mode, summary || "none"].join(" | ");
}

function runLabel(run: LoadedRun): string {
  return `${run.data.provider} ${run.spec.mode}`;
}

function displayPath(path: string): string {
  const relativePath = relative(process.cwd(), path);
  return relativePath && !relativePath.startsWith("..") ? relativePath : path;
}

function datasetLines(runs: LoadedRun[]): string[] {
  const datasets = Array.from(new Set(runs.map((run) => run.data.dataset).filter((dataset): dataset is string => Boolean(dataset))));
  if (datasets.length === 0) {
    return ["- Dataset: result files do not record dataset path."];
  }
  return datasets.map((dataset) => `- Dataset: \`${displayPath(dataset)}\`.`);
}

function envLines(runs: LoadedRun[]): string[] {
  const counts = new Map<string, number>();
  for (const run of runs) {
    for (const [envType, count] of Object.entries(run.data.task_env_counts ?? {})) {
      counts.set(envType, Math.max(counts.get(envType) ?? 0, count));
    }
  }
  if (counts.size === 0) {
    return ["- Task env mapping: result files do not record env counts."];
  }
  return [...counts.entries()].map(([envType, count]) => `- Task env mapping: \`${envType}\` (${count} tasks).`);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const discovered = discoverRuns(args.resultsDir);
  const runs = await Promise.all(discovered.specs.map(loadRun));
  const generatedAt = new Date().toISOString();
  const taskHeader = ["task", ...runs.map(runLabel)].join(" | ");
  const taskDivider = ["---", ...runs.map(() => "---")].join(" | ");

  const lines = [
    "# Sandbox Provider Warm/Cold Price Report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Scope",
    "",
    ...datasetLines(runs),
    ...envLines(runs),
    "- Solve runs cover cold and warm startup for Vercel, Modal, and Daytona using `scripts/openrouter_solver.sh` through OpenRouter.",
    "- Verifier-only runs are intentionally excluded from this report.",
    "",
    "## Task Environment Mapping",
    "",
    "env type | workdir | provider runtime mapping | notes",
    "--- | --- | --- | ---",
    "`terminalbench` | `/workspace` | configured `--runtime` | Generic TerminalBench archive layout.",
    "`harbor_swesmith` | `/testbed` | Modal/Daytona use task `environment/Dockerfile` base image; Vercel requires a prebuilt snapshot/runtime | SWE-Smith archives include `tests/test.sh`, `solution/*`, and task Docker context.",
    "",
    "## Warm Vs Cold Price",
    "",
    "provider | cold provider cost | warm provider cost | warm minus cold | warm/cold",
    "--- | ---: | ---: | ---: | ---:",
    ...PROVIDERS.map((provider) => priceRow(provider, runs)),
    "",
    "## Solve Rollup",
    "",
    "provider | mode | passed | total seconds | mean seconds | median seconds | p95 seconds | estimated provider cost",
    "--- | --- | ---: | ---: | ---: | ---: | ---: | ---:",
    ...runs.map(summaryRow),
    "",
    "## Mean Phase Seconds",
    "",
    "provider | mode | start | upload | prepare | instruction write | solve | verify | stop",
    "--- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---:",
    ...runs.map(phaseRow),
    "",
    "## Failure Signals",
    "",
    "provider | mode | signals",
    "--- | --- | ---",
    ...runs.map(failureRow),
    "",
    "## Per Task",
    "",
    taskHeader,
    taskDivider,
    ...taskRows(runs),
    "",
    "## Failed Tasks",
    "",
    ...runs.map((run) => `- ${runLabel(run)}: ${missingTasks(run)}`),
    "",
    "## Raw Artifacts",
    "",
    ...runs.map((run) => `- ${runLabel(run)}: \`${run.spec.path}\``),
    ...discovered.missing.map((run) => `- missing ${run.provider} ${run.mode}: \`${run.path}\``),
    "",
    "## Notes",
    "",
    "- Per-task rows intentionally omit per-task price; provider cost is reported only at run level.",
    "- The matrix runner caps Modal and Daytona task concurrency by default to avoid known provider rate, CPU, and memory limits while still running all provider/mode runs concurrently.",
    "- For task-Docker datasets such as SWE-Smith, the matrix runner does not reuse generic Modal or Daytona warm artifacts because each task needs its own image.",
    "- Vercel cannot consume the per-task Docker image directly; SWE-Smith Vercel runs require an equivalent task-compatible runtime or snapshot.",
    "- Cost estimates are harness estimates based on configured provider rates and measured elapsed time; they do not include OpenRouter model spend.",
    "- Cold and warm runs are only directly comparable when they use the same task set, solver command, model, resource settings, and concurrency."
  ];

  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${lines.join("\n")}\n`);
  console.log(`wrote ${args.output}`);
}

await main();
