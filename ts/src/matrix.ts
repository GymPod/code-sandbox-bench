import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ProviderName, RunMode } from "./types";

type MatrixProvider = Exclude<ProviderName, "local">;

type MatrixArgs = {
  providers: MatrixProvider[];
  modes: RunMode[];
  dataset: string;
  taskIndex: string;
  taskLimit?: number;
  outputDir: string;
  suffix: string;
  timeoutSeconds: number;
  solveTimeoutSeconds: number;
  concurrency: number;
  vercelConcurrency?: number;
  modalConcurrency?: number;
  daytonaConcurrency?: number;
  awsMicrovmConcurrency?: number;
  runConcurrency: number;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  solveCommandFile: string;
  forwardEnv: string[];
  prewarmProfile: string;
  vercelRuntime: string;
  modalRuntime: string;
  daytonaRuntime: string;
  awsMicrovmRuntime: string;
  vercelSnapshotId?: string;
  modalImageId?: string;
  daytonaSnapshot?: string;
  awsMicrovmImageId?: string;
  awsMicrovmImageVersion?: string;
  awsMicrovmExecutionRoleArn?: string;
  output?: string;
};

type RunSpec = {
  provider: MatrixProvider;
  mode: RunMode;
  runtime: string;
  taskConcurrency: number;
  output: string;
  argv: string[];
};

type RunResult = {
  provider: MatrixProvider;
  mode: RunMode;
  runtime: string;
  task_concurrency: number;
  output: string;
  exit_code: number;
  passed?: number;
  task_count?: number;
  all_passed?: boolean;
  elapsed_seconds: number;
};

const ALL_PROVIDERS: MatrixProvider[] = ["vercel", "modal", "daytona", "aws-microvm"];
const ALL_MODES: RunMode[] = ["cold", "warm"];

function parseArgs(argv: string[]): MatrixArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  const providers = parseList(values.get("--providers") ?? "all", ALL_PROVIDERS);
  const modes = parseList(values.get("--modes") ?? "cold,warm", ALL_MODES);
  return {
    providers,
    modes,
    dataset: resolve(values.get("--dataset") ?? resolve(import.meta.dir, "../../data/swesmith_v4_smoke100.jsonl")),
    taskIndex: values.get("--task-index") ?? "all",
    taskLimit: parseOptionalInt(values.get("--task-limit")),
    outputDir: resolve(values.get("--output-dir") ?? resolve(import.meta.dir, "../../results")),
    suffix: values.get("--suffix") ?? yyyymmdd(new Date()),
    timeoutSeconds: Number.parseInt(values.get("--timeout-seconds") ?? "180", 10),
    solveTimeoutSeconds: Number.parseInt(values.get("--solve-timeout-seconds") ?? "900", 10),
    concurrency: Number.parseInt(values.get("--concurrency") ?? "100", 10),
    vercelConcurrency: parseOptionalInt(values.get("--vercel-concurrency")),
    modalConcurrency: parseOptionalInt(values.get("--modal-concurrency")),
    daytonaConcurrency: parseOptionalInt(values.get("--daytona-concurrency")),
    awsMicrovmConcurrency: parseOptionalInt(values.get("--aws-microvm-concurrency")),
    runConcurrency: Number.parseInt(values.get("--run-concurrency") ?? String(providers.length * modes.length), 10),
    cpu: Number.parseInt(values.get("--cpu") ?? "2", 10),
    memoryGb: Number.parseInt(values.get("--memory-gb") ?? "4", 10),
    diskGb: Number.parseInt(values.get("--disk-gb") ?? "10", 10),
    solveCommandFile: resolve(values.get("--solve-command-file") ?? resolve(import.meta.dir, "../../scripts/openrouter_solver.sh")),
    forwardEnv: parseForwardEnv(values.get("--forward-env")),
    prewarmProfile: values.get("--prewarm-profile") ?? "terminalbench-smoke",
    vercelRuntime: values.get("--vercel-runtime") ?? "python3.13",
    modalRuntime: values.get("--modal-runtime") ?? "python:3.13",
    daytonaRuntime: values.get("--daytona-runtime") ?? "python:3.13",
    awsMicrovmRuntime: values.get("--aws-microvm-runtime") ?? "python3.13",
    vercelSnapshotId: values.get("--vercel-snapshot-id") ?? process.env.VERCEL_SNAPSHOT_ID,
    modalImageId: values.get("--modal-image-id") ?? process.env.MODAL_IMAGE_ID,
    daytonaSnapshot: values.get("--daytona-snapshot") ?? process.env.DAYTONA_SNAPSHOT,
    awsMicrovmImageId: values.get("--aws-microvm-image-id") ?? process.env.AWS_MICROVM_IMAGE_ID,
    awsMicrovmImageVersion: values.get("--aws-microvm-image-version") ?? process.env.AWS_MICROVM_IMAGE_VERSION,
    awsMicrovmExecutionRoleArn: values.get("--aws-microvm-execution-role-arn") ?? process.env.AWS_MICROVM_EXECUTION_ROLE_ARN,
    output: values.get("--output")
  };
}

function parseOptionalInt(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number.parseInt(value, 10);
}

function parseList<T extends string>(value: string, allowed: readonly T[]): T[] {
  if (value === "all") {
    return [...allowed];
  }
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of items) {
    if (!allowed.includes(item as T)) {
      throw new Error(`Unsupported value: ${item}`);
    }
  }
  return items as T[];
}

function parseForwardEnv(value: string | undefined): string[] {
  return (value ?? "OPENROUTER_API_KEY,OPENROUTER_MODEL,SOLVER_MAX_STEPS,SOLVER_STEP_TIMEOUT_SECONDS")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function yyyymmdd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function runtimeFor(provider: MatrixProvider, args: MatrixArgs): string {
  if (provider === "vercel") {
    return args.vercelRuntime;
  }
  if (provider === "modal") {
    return args.modalRuntime;
  }
  if (provider === "aws-microvm") {
    return args.awsMicrovmRuntime;
  }
  return args.daytonaRuntime;
}

function buildRunSpecs(args: MatrixArgs): RunSpec[] {
  return args.providers.flatMap((provider) =>
    args.modes.map((mode) => {
      const runtime = runtimeFor(provider, args);
      const taskConcurrency = taskConcurrencyFor(provider, args);
      const output = `${args.outputDir}/ts-${provider}-${mode}-solve-all-${args.suffix}.json`;
      const argv = [
        "src/bench.ts",
        "--provider",
        provider,
        "--mode",
        mode,
        "--dataset",
        args.dataset,
        "--task-index",
        args.taskIndex,
        ...(args.taskLimit === undefined ? [] : ["--task-limit", String(args.taskLimit)]),
        "--runtime",
        runtime,
        "--timeout-seconds",
        String(args.timeoutSeconds),
        "--solve-timeout-seconds",
        String(args.solveTimeoutSeconds),
        "--concurrency",
        String(taskConcurrency),
        "--cpu",
        String(args.cpu),
        "--memory-gb",
        String(args.memoryGb),
        "--disk-gb",
        String(args.diskGb),
        "--forward-env",
        args.forwardEnv.join(","),
        "--solve-command-file",
        args.solveCommandFile,
        "--output",
        output
      ];
      argv.push(...warmProviderArgs(provider, mode, args));
      argv.push(...awsMicrovmArgs(provider, args));
      return { provider, mode, runtime, taskConcurrency, output, argv };
    })
  );
}

function taskConcurrencyFor(provider: MatrixProvider, args: MatrixArgs): number {
  const modeCount = Math.max(1, args.modes.length);
  if (provider === "vercel") {
    return args.vercelConcurrency ?? (usesTaskDockerDataset(args) ? 1 : args.concurrency);
  }
  if (provider === "modal") {
    return args.modalConcurrency ?? (usesTaskDockerDataset(args) ? 1 : Math.min(args.concurrency, Math.max(1, Math.floor(5 / modeCount))));
  }
  if (provider === "aws-microvm") {
    const accountMemoryGb = envNumber("AWS_MICROVM_ACCOUNT_MEMORY_GB", 4);
    const memoryCap = Math.max(1, Math.floor(accountMemoryGb / args.memoryGb / modeCount));
    return args.awsMicrovmConcurrency ?? Math.min(args.concurrency, memoryCap);
  }
  const cpuCap = Math.floor(10 / args.cpu / modeCount);
  const memoryCap = Math.floor(10 / args.memoryGb / modeCount);
  return args.daytonaConcurrency ?? Math.min(args.concurrency, Math.max(1, Math.min(cpuCap, memoryCap)));
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  return value === undefined ? fallback : Number.parseFloat(value);
}

function usesTaskDockerDataset(args: MatrixArgs): boolean {
  const firstLine = readFileSync(args.dataset, "utf8").split("\n").find(Boolean);
  if (!firstLine) {
    return false;
  }
  const task = JSON.parse(firstLine) as { env_type?: string; data_source?: string };
  return task.env_type === "harbor_swesmith" || task.data_source === "harbor_swesmith";
}

function warmProviderArgs(provider: MatrixProvider, mode: RunMode, args: MatrixArgs): string[] {
  if (mode === "cold") {
    return [];
  }
  if (usesTaskDockerDataset(args)) {
    return [];
  }
  if (provider === "vercel") {
    return args.vercelSnapshotId ? ["--vercel-snapshot-id", args.vercelSnapshotId] : [];
  }
  if (provider === "modal") {
    return args.modalImageId ? ["--modal-image-id", args.modalImageId] : [];
  }
  if (args.daytonaSnapshot) {
    return ["--daytona-snapshot", args.daytonaSnapshot];
  }
  return args.dataset.includes("terminalbench") ? ["--prewarm-profile", args.prewarmProfile] : [];
}

function awsMicrovmArgs(provider: MatrixProvider, args: MatrixArgs): string[] {
  if (provider !== "aws-microvm") {
    return [];
  }
  return [
    ...(args.awsMicrovmImageId ? ["--aws-microvm-image-id", args.awsMicrovmImageId] : []),
    ...(args.awsMicrovmImageVersion ? ["--aws-microvm-image-version", args.awsMicrovmImageVersion] : []),
    ...(args.awsMicrovmExecutionRoleArn ? ["--aws-microvm-execution-role-arn", args.awsMicrovmExecutionRoleArn] : [])
  ];
}

async function runSpec(spec: RunSpec): Promise<RunResult> {
  mkdirSync(dirname(spec.output), { recursive: true });
  const started = performance.now();
  console.log(`starting ${spec.provider} ${spec.mode}: ${spec.output}`);
  const proc = Bun.spawn(["bun", ...spec.argv], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "inherit",
    stderr: "inherit",
    env: process.env
  });
  const exitCode = await proc.exited;
  const elapsedSeconds = (performance.now() - started) / 1000;
  const runSummary = readBenchSummary(spec.output);
  console.log(`finished ${spec.provider} ${spec.mode}: exit ${exitCode}, ${elapsedSeconds.toFixed(2)}s`);
  return {
    provider: spec.provider,
    mode: spec.mode,
    runtime: spec.runtime,
    task_concurrency: spec.taskConcurrency,
    output: spec.output,
    exit_code: exitCode,
    passed: runSummary?.passed,
    task_count: runSummary?.task_count,
    all_passed: runSummary ? runSummary.passed === runSummary.task_count : undefined,
    elapsed_seconds: elapsedSeconds
  };
}

function readBenchSummary(output: string): { passed: number; task_count: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(output, "utf8")) as { passed?: unknown; task_count?: unknown };
    if (typeof parsed.passed === "number" && typeof parsed.task_count === "number") {
      return { passed: parsed.passed, task_count: parsed.task_count };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function runWithConcurrency(specs: RunSpec[], concurrency: number): Promise<RunResult[]> {
  const results: RunResult[] = new Array(specs.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, specs.length));
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= specs.length) {
        return;
      }
      results[index] = await runSpec(specs[index]);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const specs = buildRunSpecs(args);
  const results = await runWithConcurrency(specs, args.runConcurrency);
  const summary = {
    generated_at: new Date().toISOString(),
    requested_task_concurrency_per_run: args.concurrency,
    effective_task_concurrency_per_run: Object.fromEntries(specs.map((spec) => [`${spec.provider}-${spec.mode}`, spec.taskConcurrency])),
    run_concurrency: args.runConcurrency,
    results
  };
  const output = `${JSON.stringify(summary, null, 2)}\n`;
  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, output);
  }
  console.log(output);
  if (results.some((result) => result.exit_code !== 0 || result.all_passed === false)) {
    process.exitCode = 1;
  }
}

await main();
