import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadTasks } from "./dataset";
import { makeProvider, writeText } from "./providers";
import type { BenchArgs, BenchTask, CommandResult } from "./types";

const prepareCommand = `
set -eu
mkdir -p /tmp/tb /workspace /tests /solution /logs/verifier
python3 - <<'PY'
import base64
from pathlib import Path
Path("/tmp/task.tar.gz").write_bytes(base64.b64decode(Path("/tmp/task.tar.gz.b64").read_text()))
PY
tar -xzf /tmp/task.tar.gz -C /tmp/tb
cp -a /tmp/tb/. /workspace/
if [ -d /tmp/tb/tests ]; then cp -a /tmp/tb/tests/. /tests/; fi
if [ -d /tmp/tb/solution ]; then cp -a /tmp/tb/solution/. /solution/; fi
python3 -m ensurepip --user >/tmp/ensurepip.log 2>&1 || true
python3 -m pip install --user pytest==8.4.1 >/tmp/pip-pytest.log 2>&1 || true
`;
const verifyCommand = `
set +e
if [ -x /tests/test.sh ] || [ -f /tests/test.sh ]; then
  bash /tests/test.sh
else
  PATH="$HOME/.local/bin:$PATH" pytest /tests/test_outputs.py -rA
fi
code=$?
if [ "$code" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
exit "$code"
`;

function parseArgs(argv: string[]): BenchArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  const provider = (values.get("--provider") ?? "local") as BenchArgs["provider"];
  return {
    provider,
    dataset: values.get("--dataset") ?? resolve(import.meta.dir, "../../data/terminalbench_2026_03_05_smoke16.jsonl"),
    taskIndex: values.get("--task-index") ?? "all",
    runtime: values.get("--runtime") ?? "python3.13",
    timeoutSeconds: Number.parseInt(values.get("--timeout-seconds") ?? "180", 10),
    solveTimeoutSeconds: Number.parseInt(values.get("--solve-timeout-seconds") ?? values.get("--timeout-seconds") ?? "180", 10),
    solveCommand: values.get("--solve-command"),
    solveCommandFile: values.get("--solve-command-file"),
    forwardEnv: parseForwardEnv(values.get("--forward-env")),
    prewarmProfile: values.get("--prewarm-profile"),
    vercelSnapshotId: values.get("--vercel-snapshot-id") ?? process.env.VERCEL_SNAPSHOT_ID,
    modalImageId: values.get("--modal-image-id") ?? process.env.MODAL_IMAGE_ID,
    daytonaSnapshot: values.get("--daytona-snapshot") ?? process.env.DAYTONA_SNAPSHOT,
    concurrency: Number.parseInt(values.get("--concurrency") ?? "1", 10),
    cpu: Number.parseInt(values.get("--cpu") ?? "2", 10),
    memoryGb: Number.parseInt(values.get("--memory-gb") ?? "4", 10),
    diskGb: Number.parseInt(values.get("--disk-gb") ?? "10", 10),
    output: values.get("--output")
  };
}

function parseForwardEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveSolveCommand(args: BenchArgs): string | undefined {
  if (args.solveCommandFile) {
    return readFileSync(args.solveCommandFile, "utf8");
  }
  return args.solveCommand;
}

function estimateCost(provider: string, seconds: number, cpu: number, memoryGb: number, diskGb: number): number {
  if (provider === "vercel") {
    return (seconds / 3600) * (cpu * 0.128 + memoryGb * 0.0212) + 0.60 / 1_000_000;
  }
  if (provider === "modal") {
    return seconds * ((cpu / 2) * 0.00003942 + memoryGb * 0.00000672);
  }
  if (provider === "daytona") {
    const billableStorageGb = Math.max(0, diskGb - 5);
    return seconds * (cpu * 0.000014 + memoryGb * 0.0000045 + billableStorageGb * 0.00000003);
  }
  return 0;
}

async function runTask(args: BenchArgs, task: BenchTask): Promise<Record<string, unknown>> {
  const provider = makeProvider(args.provider, {
    runtime: args.runtime,
    timeoutSeconds: args.timeoutSeconds,
    cpu: args.cpu,
    memoryGb: args.memoryGb,
    diskGb: args.diskGb,
    prewarmProfile: args.prewarmProfile,
    vercelSnapshotId: args.vercelSnapshotId,
    modalImageId: args.modalImageId,
    daytonaSnapshot: args.daytonaSnapshot
  });
  const solveCommand = resolveSolveCommand(args);
  const started = performance.now();
  let solveElapsedSeconds: number | undefined;
  let solveResult: CommandResult | undefined;
  let result: CommandResult = { stdout: "", stderr: "", returnCode: 1 };
  const phases: Record<string, number> = {};
  async function timed<T>(name: string, action: () => Promise<T>): Promise<T> {
    const phaseStarted = performance.now();
    try {
      return await action();
    } finally {
      phases[`${name}_seconds`] = (performance.now() - phaseStarted) / 1000;
    }
  }
  try {
    await timed("start", () => provider.start());
    await timed("upload", () => writeText(provider, "/tmp/task.tar.gz.b64", task.task_files.content, args.timeoutSeconds));
    const prepare = await timed("prepare", () => provider.run(prepareCommand, undefined, args.timeoutSeconds));
    if (prepare.returnCode === 0) {
      await timed("instruction_write", () => writeTaskInstructions(provider, task, args.timeoutSeconds));
      if (solveCommand) {
        const solveStarted = performance.now();
        solveResult = await timed("solve", () =>
          provider.run(withForwardedEnv(solveCommand, args.forwardEnv), "/workspace", args.solveTimeoutSeconds)
        );
        solveElapsedSeconds = (performance.now() - solveStarted) / 1000;
      }
      result = await timed("verify", () => provider.run(verifyCommand, "/workspace", args.timeoutSeconds));
    } else {
      result = prepare;
    }
  } finally {
    await timed("stop", () => provider.stop());
  }
  const elapsedSeconds = (performance.now() - started) / 1000;
  const item: Record<string, unknown> = {
    task_id: task.task_id,
    passed: result.returnCode === 0,
    return_code: result.returnCode,
    elapsed_seconds: elapsedSeconds,
    estimated_cost_usd: estimateCost(args.provider, elapsedSeconds, args.cpu, args.memoryGb, args.diskGb),
    phases,
    stdout_tail: result.stdout.slice(-2000),
    stderr_tail: result.stderr.slice(-2000)
  };
  if (solveResult) {
    item.solve_return_code = solveResult.returnCode;
    item.solve_elapsed_seconds = solveElapsedSeconds;
    item.solve_stdout_tail = solveResult.stdout.slice(-2000);
    item.solve_stderr_tail = solveResult.stderr.slice(-2000);
  }
  return item;
}

async function writeTaskInstructions(provider: ReturnType<typeof makeProvider>, task: BenchTask, timeoutSeconds: number): Promise<void> {
  const prompt = task.prompt || task.instruction;
  const instruction = task.instruction || task.prompt;
  const taskMarkdown = [
    `# ${task.task_id}`,
    "",
    "## Prompt",
    prompt.trim(),
    "",
    "## Instruction",
    instruction.trim(),
    "",
    "Work in `/workspace`. The verifier will run from `/workspace` after your command exits."
  ].join("\n");

  await writeText(provider, "/tmp/task_prompt.md", prompt, timeoutSeconds);
  await writeText(provider, "/tmp/task_instruction.md", instruction, timeoutSeconds);
  await writeText(provider, "/workspace/TASK.md", taskMarkdown, timeoutSeconds);
}

function withForwardedEnv(command: string, names: string[]): string {
  const exports = names
    .map((name) => [name, process.env[name]] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`);
  if (exports.length === 0) {
    return command;
  }
  return `${exports.join("\n")}\n${command}`;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const tasks = loadTasks(args.dataset, args.taskIndex);
  const results = await runWithConcurrency(tasks, args);
  const summary = {
    provider: args.provider,
    runtime: args.runtime,
    task_count: results.length,
    solve_enabled: Boolean(resolveSolveCommand(args)),
    passed: results.filter((item) => item.passed).length,
    estimated_cost_usd: results.reduce((sum, item) => sum + Number(item.estimated_cost_usd), 0),
    results
  };
  const output = `${JSON.stringify(summary, null, 2)}\n`;
  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, output);
  }
  console.log(output);
}

async function runWithConcurrency(tasks: BenchTask[], args: BenchArgs): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = new Array(tasks.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(args.concurrency, tasks.length));
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) {
        return;
      }
      const task = tasks[index];
      console.log(`running ${task.task_id} on ${args.provider}`);
      results[index] = await runTask(args, task);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

await main();
