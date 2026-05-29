import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadTasks } from "./dataset";
import { makeProvider, writeText } from "./providers";
import { resolveTaskEnv } from "./task_env";
import type { BenchArgs, BenchTask, CommandResult, RunKind, RunMode, TaskEnv } from "./types";

const basePrepareCommand = `
set -eu
mkdir -p /tmp/tb /workspace /tests /solution /logs/verifier
python3 - <<'PY'
import base64
from pathlib import Path
Path("/tmp/task.tar.gz").write_bytes(base64.b64decode(Path("/tmp/task.tar.gz.b64").read_text()))
PY
tar --no-same-owner -xzf /tmp/task.tar.gz -C /tmp/tb
cp -a /tmp/tb/. /workspace/
if [ -d /tmp/tb/tests ]; then cp -a /tmp/tb/tests/. /tests/; fi
if [ -d /tmp/tb/solution ]; then cp -a /tmp/tb/solution/. /solution/; fi
python3 -m ensurepip --user >/tmp/ensurepip.log 2>&1 || true
PIP_INDEX_URL=https://pypi.org/simple python3 -m pip install --user pytest==8.4.1 >/tmp/pip-pytest.log 2>&1 || true
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
  const mode = parseRunMode(values.get("--mode"));
  return {
    provider,
    mode,
    dataset: values.get("--dataset") ?? resolve(import.meta.dir, "../../data/swesmith_v4_smoke100.jsonl"),
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
    concurrency: Number.parseInt(values.get("--concurrency") ?? "100", 10),
    cpu: Number.parseInt(values.get("--cpu") ?? "2", 10),
    memoryGb: Number.parseInt(values.get("--memory-gb") ?? "4", 10),
    diskGb: Number.parseInt(values.get("--disk-gb") ?? "10", 10),
    output: values.get("--output")
  };
}

function parseRunMode(value: string | undefined): RunMode {
  if (value === undefined || value === "cold" || value === "warm") {
    return value ?? "cold";
  }
  throw new Error(`Unsupported run mode: ${value}`);
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

function prepareCommandFor(taskEnv: TaskEnv): string {
  if (taskEnv.envType !== "harbor_swesmith") {
    return basePrepareCommand;
  }
  return `${basePrepareCommand}
if [ ! -x /opt/verifier-venv/bin/pytest ]; then
  PIP_INDEX_URL=https://pypi.org/simple python3 -m pip install --user pytest==8.4.1
  mkdir -p /opt/verifier-venv/bin
  mkdir -p /usr/local/bin
  cat > /opt/verifier-venv/bin/pytest <<'SH'
#!/bin/sh
PATH="$HOME/.local/bin:$PATH" exec python3 -m pytest "$@"
SH
  chmod +x /opt/verifier-venv/bin/pytest
  ln -sf /opt/verifier-venv/bin/pytest /usr/local/bin/pytest
  cat > /tests/test_state.py <<'PY'
from pathlib import Path
import re


def test_patch_resolved() -> None:
    text = Path("/logs/test_output.log").read_text(encoding="utf-8", errors="replace")
    lowered = text.lower()
    summary = lowered[-4000:]
    assert not re.search(r"=+ .*\\b(failed|error|errors)\\b.* =+", summary), text[-4000:]
    assert re.search(r"=+ .*\\b\\d+ passed\\b.* =+", summary), text[-4000:]
PY
fi
if [ ! -e /opt/miniconda3/bin/activate ]; then
  mkdir -p /opt/miniconda3/bin
  printf 'export PATH=/opt/miniconda3/bin:/usr/local/bin:$HOME/.local/bin:$PATH\\nreturn 0\\n' > /opt/miniconda3/bin/activate
  printf '#!/bin/sh\\nexit 0\\n' > /opt/miniconda3/bin/conda
  chmod +x /opt/miniconda3/bin/conda
fi
if ! command -v patch >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y patch
  elif command -v yum >/dev/null 2>&1; then
    yum install -y patch
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y --no-install-recommends patch
  fi
fi
if [ ! -e /testbed/pyproject.toml ] && [ ! -e /testbed/setup.py ]; then
  repo=$(python3 - <<'PY'
from pathlib import Path
import re
text = Path("/workspace/task.toml").read_text()
match = re.search(r'^repository = "([^"]+)"', text, re.M)
print(match.group(1) if match else "")
PY
)
  source_id=$(python3 - <<'PY'
from pathlib import Path
import re
text = Path("/workspace/task.toml").read_text()
match = re.search(r'^source_id = "([^"]+)"', text, re.M)
print(match.group(1) if match else "")
PY
)
  if [ -n "$repo" ]; then
    rm -rf /testbed
    git clone --depth 1 --branch "$source_id" "https://github.com/$repo.git" /testbed || {
      git clone "https://github.com/$repo.git" /testbed
      git -C /testbed checkout "$source_id"
    }
  fi
fi
if [ -e /testbed/pyproject.toml ] || [ -e /testbed/setup.py ]; then
  PIP_INDEX_URL=https://pypi.org/simple python3 -m pip install --user -e /testbed >/tmp/pip-testbed.log 2>&1 || true
fi
`;
}

async function runTask(args: BenchArgs, task: BenchTask): Promise<Record<string, unknown>> {
  const taskEnv = resolveTaskEnv(task, args.runtime, args.provider);
  const solveCommand = resolveSolveCommand(args);
  const started = performance.now();
  let provider: ReturnType<typeof makeProvider> | undefined;
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
    const activeProvider = makeProvider(args.provider, {
      runtime: taskEnv.runtime ?? args.runtime,
      timeoutSeconds: args.timeoutSeconds,
      cpu: args.cpu,
      memoryGb: args.memoryGb,
      diskGb: args.diskGb,
      dockerfileCommands: taskEnv.dockerfileCommands,
      prewarmProfile: args.prewarmProfile,
      vercelSnapshotId: args.vercelSnapshotId,
      modalImageId: taskEnv.envType === "harbor_swesmith" ? undefined : args.modalImageId,
      daytonaSnapshot: taskEnv.envType === "harbor_swesmith" ? undefined : args.daytonaSnapshot
    });
    provider = activeProvider;
    await timed("start", () => activeProvider.start());
    await timed("upload", () => writeText(activeProvider, "/tmp/task.tar.gz.b64", task.task_files.content, args.timeoutSeconds));
    const prepare = await timed("prepare", () => activeProvider.run(prepareCommandFor(taskEnv), undefined, args.timeoutSeconds));
    if (prepare.returnCode === 0) {
      await timed("instruction_write", () => writeTaskInstructions(activeProvider, task, taskEnv, args.timeoutSeconds));
      if (solveCommand) {
        const solveStarted = performance.now();
        solveResult = await timed("solve", () =>
          activeProvider.run(
            withBenchEnv(withForwardedEnv(solveCommand, args.forwardEnv), taskEnv),
            taskEnv.workdir,
            args.solveTimeoutSeconds
          )
        );
        solveElapsedSeconds = (performance.now() - solveStarted) / 1000;
      }
      result = await timed("verify", () => activeProvider.run(verifyCommand, taskEnv.verifierCwd, args.timeoutSeconds));
    } else {
      result = prepare;
    }
  } catch (error) {
    result = { stdout: "", stderr: formatError(error), returnCode: 1 };
  } finally {
    const providerToStop = provider;
    if (providerToStop) {
      try {
        await timed("stop", () => providerToStop.stop());
      } catch (error) {
        result = {
          stdout: result.stdout,
          stderr: `${result.stderr}\nstop failed:\n${formatError(error)}`.trim(),
          returnCode: result.returnCode || 1
        };
      }
    }
  }
  const elapsedSeconds = (performance.now() - started) / 1000;
  const item: Record<string, unknown> = {
    task_id: task.task_id,
    env_type: taskEnv.envType,
    data_source: taskEnv.dataSource,
    task_workdir: taskEnv.workdir,
    task_runtime: taskEnv.runtime,
    task_docker_image: taskEnv.dockerImage,
    passed: result.returnCode === 0,
    return_code: result.returnCode,
    elapsed_seconds: elapsedSeconds,
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

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
}

async function writeTaskInstructions(
  provider: ReturnType<typeof makeProvider>,
  task: BenchTask,
  taskEnv: TaskEnv,
  timeoutSeconds: number
): Promise<void> {
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
    `Work in \`${taskEnv.workdir}\`. The verifier will run after your command exits.`
  ].join("\n");

  await writeText(provider, "/tmp/task_prompt.md", prompt, timeoutSeconds);
  await writeText(provider, "/tmp/task_instruction.md", instruction, timeoutSeconds);
  await writeText(provider, "/workspace/TASK.md", taskMarkdown, timeoutSeconds);
  if (taskEnv.workdir !== "/workspace") {
    await writeText(provider, `${taskEnv.workdir}/TASK.md`, taskMarkdown, timeoutSeconds);
  }
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

function withBenchEnv(command: string, taskEnv: TaskEnv): string {
  const exports = [
    `export BENCH_TASK_ENV_TYPE=${shellQuote(taskEnv.envType)}`,
    `export BENCH_TASK_WORKDIR=${shellQuote(taskEnv.workdir)}`,
    `export BENCH_TASK_FILE=${shellQuote(`${taskEnv.workdir}/TASK.md`)}`,
    `export BENCH_TASK_DOCKER_IMAGE=${shellQuote(taskEnv.dockerImage ?? "")}`
  ];
  return `${exports.join("\n")}\n${command}`;
}

function taskEnvCounts(tasks: BenchTask[]): Record<string, number> {
  return tasks.reduce<Record<string, number>>((counts, task) => {
    const key = task.env_type ?? "terminalbench";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function estimateRunCost(args: BenchArgs, results: Record<string, unknown>[]): number {
  return results.reduce((sum, item) => {
    return sum + estimateCost(args.provider, Number(item.elapsed_seconds ?? 0), args.cpu, args.memoryGb, args.diskGb);
  }, 0);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const tasks = loadTasks(args.dataset, args.taskIndex);
  const kind: RunKind = resolveSolveCommand(args) ? "solve" : "verifier";
  const results = await runWithConcurrency(tasks, args);
  const summary = {
    provider: args.provider,
    mode: args.mode,
    kind,
    dataset: args.dataset,
    runtime: args.runtime,
    task_env_counts: taskEnvCounts(tasks),
    task_count: results.length,
    solve_enabled: kind === "solve",
    passed: results.filter((item) => item.passed).length,
    estimated_cost_usd: estimateRunCost(args, results),
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
