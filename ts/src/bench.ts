import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadTasks } from "./dataset";
import { makeProvider, writeText } from "./providers";
import type { BenchArgs, BenchTask, CommandResult } from "./types";

const prepareCommand = `
set -eu
mkdir -p /tmp/tb /workspace /tests /logs/verifier
python3 - <<'PY'
import base64
from pathlib import Path
Path("/tmp/task.tar.gz").write_bytes(base64.b64decode(Path("/tmp/task.tar.gz.b64").read_text()))
PY
tar -xzf /tmp/task.tar.gz -C /tmp/tb
cp -a /tmp/tb/. /workspace/
cp -a /tmp/tb/tests/. /tests/
python3 -m ensurepip --user >/tmp/ensurepip.log 2>&1 || true
python3 -m pip install --user pytest==8.4.1 >/tmp/pip-pytest.log 2>&1 || true
`;
const verifyCommand = `
set +e
PATH="$HOME/.local/bin:$PATH" pytest /tests/test_outputs.py -rA
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
    concurrency: Number.parseInt(values.get("--concurrency") ?? "1", 10),
    cpu: Number.parseInt(values.get("--cpu") ?? "2", 10),
    memoryGb: Number.parseInt(values.get("--memory-gb") ?? "4", 10),
    diskGb: Number.parseInt(values.get("--disk-gb") ?? "10", 10),
    output: values.get("--output")
  };
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
  const provider = makeProvider(args.provider, args.runtime, args.timeoutSeconds, args.cpu, args.memoryGb, args.diskGb);
  const started = performance.now();
  let result: CommandResult = { stdout: "", stderr: "", returnCode: 1 };
  try {
    await provider.start();
    await writeText(provider, "/tmp/task.tar.gz.b64", task.task_files.content, args.timeoutSeconds);
    const prepare = await provider.run(prepareCommand, undefined, args.timeoutSeconds);
    result = prepare.returnCode === 0 ? await provider.run(verifyCommand, "/workspace", args.timeoutSeconds) : prepare;
  } finally {
    await provider.stop();
  }
  const elapsedSeconds = (performance.now() - started) / 1000;
  return {
    task_id: task.task_id,
    passed: result.returnCode === 0,
    return_code: result.returnCode,
    elapsed_seconds: elapsedSeconds,
    estimated_cost_usd: estimateCost(args.provider, elapsedSeconds, args.cpu, args.memoryGb, args.diskGb),
    stdout_tail: result.stdout.slice(-2000),
    stderr_tail: result.stderr.slice(-2000)
  };
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const tasks = loadTasks(args.dataset, args.taskIndex);
  const results = await runWithConcurrency(tasks, args);
  const summary = {
    provider: args.provider,
    runtime: args.runtime,
    task_count: results.length,
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

await main();
