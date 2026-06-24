import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadTasks } from "./dataset";
import { makeProvider, writeText } from "./providers";
import { resolveTaskEnv } from "./task_env";
import type { BenchArgs, BenchTask, CommandResult, ProviderName, RunKind, RunMode, TaskEnv } from "./types";

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
    taskLimit: parseOptionalInt(values.get("--task-limit")),
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
    awsMicrovmImageId: values.get("--aws-microvm-image-id") ?? process.env.AWS_MICROVM_IMAGE_ID,
    awsMicrovmImageVersion: values.get("--aws-microvm-image-version") ?? process.env.AWS_MICROVM_IMAGE_VERSION,
    awsMicrovmExecutionRoleArn: values.get("--aws-microvm-execution-role-arn") ?? process.env.AWS_MICROVM_EXECUTION_ROLE_ARN,
    concurrency: Number.parseInt(values.get("--concurrency") ?? "100", 10),
    cpu: Number.parseInt(values.get("--cpu") ?? "2", 10),
    memoryGb: Number.parseInt(values.get("--memory-gb") ?? "4", 10),
    diskGb: Number.parseInt(values.get("--disk-gb") ?? "10", 10),
    output: values.get("--output")
  };
}

function parseOptionalInt(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number.parseInt(value, 10);
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
  if (provider === "aws-microvm") {
    const vcpuHour = Number.parseFloat(process.env.AWS_MICROVM_ESTIMATE_VCPU_HOUR_USD ?? "0");
    const gbHour = Number.parseFloat(process.env.AWS_MICROVM_ESTIMATE_GB_HOUR_USD ?? "0");
    return (seconds / 3600) * (cpu * vcpuHour + memoryGb * gbHour);
  }
  return 0;
}

const APT_PACKAGE_NAMES: Record<string, string> = {
  "gcc-c++": "g++",
  "pkgconf-pkg-config": "pkg-config"
};

const FALLBACK_TESTBED_PIP_DEPS = [
  "pytest<9",
  "pytest-cov<7",
  "pytest-xdist",
  "pytest-timeout",
  "pytest-mock",
  "pytest-asyncio",
  "hypothesis",
  "mock"
];

// Deterministic gold solution: restore test files first, then reverse-apply
// the bug-introducing patch only while it is still present, so reruns (e.g.
// solver retries) cannot leave rejects or half-reversed state behind.
const deterministicSolveScript = `#!/bin/bash
set -uo pipefail
cd /testbed
sol_dir=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
patch -p1 --forward --reject-file=/dev/null < "$sol_dir/restore-tests.patch" || true
if patch -R -p1 --dry-run --force < "$sol_dir/gold.patch" >/dev/null 2>&1; then
  patch -R -p1 --force < "$sol_dir/gold.patch" || exit 1
fi
patch -p1 --dry-run --force < "$sol_dir/gold.patch" >/dev/null 2>&1 || exit 1
exit 0`;

const deterministicSolveRewrite = `
for bench_sol_dir in /solution /workspace/solution; do
  if [ -f "$bench_sol_dir/gold.patch" ] && [ -f "$bench_sol_dir/restore-tests.patch" ]; then
    cat > "$bench_sol_dir/solve.sh" <<'BENCH_EOF_SOLVE'
${deterministicSolveScript}
BENCH_EOF_SOLVE
    chmod +x "$bench_sol_dir/solve.sh"
  fi
done
`;

function systemPackageInstall(dnfPackages: string[]): string {
  const aptPackages = dnfPackages.map((name) => APT_PACKAGE_NAMES[name] ?? name);
  return `if command -v dnf >/dev/null 2>&1; then
    dnf install -y ${dnfPackages.join(" ")} >>/tmp/bench-system-deps.log 2>&1 || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ${dnfPackages.join(" ")} >>/tmp/bench-system-deps.log 2>&1 || true
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update >>/tmp/bench-system-deps.log 2>&1 || true
    apt-get install -y --no-install-recommends ${aptPackages.join(" ")} >>/tmp/bench-system-deps.log 2>&1 || true
  fi`;
}

function guardedShellLines(commands: string[] | undefined, label: string): string {
  return (commands ?? [])
    .map((command, index) => `{ ${command} ; } || echo "bench-${label}-cmd-failed-${index + 1}"`)
    .join("\n");
}

// Fallback environment setup for providers that cannot run the task Docker
// image (Vercel, local). The recipe comes from the per-repo manifest in
// data/swesmith_env_manifests.json, which mirrors the SWE-Smith profile the
// task image was built from: exact Python version via uv, mirror clone of the
// bug branch, then the profile's install commands inside a dedicated venv.
// The verifier venv matches the task image's (pytest/swebench/swesmith), so
// grading uses the task's real FAIL_TO_PASS/PASS_TO_PASS lists.
function fallbackEnvSetup(taskEnv: TaskEnv, provider: ProviderName): string {
  const manifest = taskEnv.manifest;
  const pythonVersion = manifest?.python_version ?? "3.10";
  const mirror = manifest?.mirror ?? (taskEnv.repoKey ? `swesmith/${taskEnv.repoKey}` : "");
  const sourceId = taskEnv.sourceId ?? "";
  const envKey = Buffer.from(
    JSON.stringify({
      repoKey: taskEnv.repoKey,
      sourceId,
      pythonVersion,
      installCmds: manifest?.install_cmds ?? [],
      preInstallPip: manifest?.pre_install_pip ?? [],
      extraPip: manifest?.extra_pip ?? [],
      systemPackages: manifest?.system_packages ?? [],
      preVerifyCmds: manifest?.pre_verify_cmds ?? []
    }),
    "utf8"
  ).toString("base64");
  const baseSystemPackages = ["git", "patch", "tar", "gzip", "gcc", "gcc-c++", "make"];
  const systemPackages = [...new Set([...baseSystemPackages, ...(manifest?.system_packages ?? [])])];
  // Each pip spec is shell-quoted: version constraints like "foo<2" or
  // "bar>=1.2" would otherwise be parsed as shell redirections.
  const quoteSpecs = (specs: string[]): string =>
    specs.flatMap((spec) => spec.split(/\s+/)).map((token) => `'${token}'`).join(" ");
  const pipInstallLines = [
    `python -m pip install ${quoteSpecs(FALLBACK_TESTBED_PIP_DEPS)} || true`,
    ...(manifest?.pre_install_pip ?? []).map(
      (spec) => `python -m pip install ${quoteSpecs([spec])} || echo "bench-install-cmd-failed: pip install ${spec}"`
    ),
    ...(manifest?.extra_pip?.length
      ? [`python -m pip install ${quoteSpecs(manifest.extra_pip)} || echo "bench-install-cmd-failed: extra pip deps"`]
      : [])
  ];
  const postInstallPinLines = (manifest?.pre_install_pip ?? []).map(
    (spec) => `python -m pip install ${quoteSpecs([spec])} || echo "bench-install-cmd-failed: post install pip ${spec}"`
  );
  const installCmdLines = (manifest?.install_cmds ?? ["python -m pip install -e ."]).map((command) => {
    const guarded = command.startsWith("apt-get")
      ? `if command -v apt-get >/dev/null 2>&1; then ${command}; fi`
      : command;
    return `{ ${guarded} ; } || echo "bench-install-cmd-failed: ${command.replaceAll('"', '\\"')}"`;
  });
  const createAgentUser =
    provider === "local"
      ? ""
      : `
  if ! id agent >/dev/null 2>&1; then
    useradd -m -u 1001 agent 2>/dev/null || useradd -m agent || true
  fi`;
  return `
BENCH_REPO='${taskEnv.repoKey ?? ""}'
BENCH_ENV_KEY='${envKey}'
if [ -f /opt/bench-fallback-repo ] && [ "$(cat /opt/bench-fallback-repo)" != "$BENCH_REPO" ]; then
  rm -rf /opt/testbed-venv /testbed /opt/bench-fallback-repo /opt/bench-fallback-env-key
  rm -f /opt/verifier-venv/bin/pytest
fi
if [ -f /opt/bench-fallback-env-key ] && [ "$(cat /opt/bench-fallback-env-key)" != "$BENCH_ENV_KEY" ]; then
  rm -rf /opt/testbed-venv /testbed /opt/bench-fallback-repo /opt/bench-fallback-env-key
  rm -f /opt/verifier-venv/bin/pytest
fi
if [ -f /opt/bench-fallback-repo ] && [ ! -f /opt/bench-fallback-env-key ]; then
  rm -rf /opt/testbed-venv /testbed /opt/bench-fallback-repo /opt/bench-fallback-env-key
  rm -f /opt/verifier-venv/bin/pytest
fi
if [ ! -x /opt/verifier-venv/bin/pytest ]; then
  ${systemPackageInstall(systemPackages)}
  python3 -m ensurepip --user >/tmp/bench-ensurepip.log 2>&1 || true
  PIP_INDEX_URL=https://pypi.org/simple python3 -m pip install --user --upgrade pip uv >/tmp/bench-pip-uv.log 2>&1 || true
  BENCH_UV=$(command -v uv || printf '%s' "$HOME/.local/bin/uv")
  export UV_PYTHON_INSTALL_DIR=/opt/uv-python
  "$BENCH_UV" python install ${pythonVersion}
  "$BENCH_UV" venv --python ${pythonVersion} --seed /opt/testbed-venv
  chmod -R a+rX /opt/uv-python /opt/testbed-venv
  export PIP_INDEX_URL=https://pypi.org/simple
  if [ ! -e /testbed/pyproject.toml ] && [ ! -e /testbed/setup.py ] && [ ! -e /testbed/setup.cfg ]; then
    rm -rf /testbed
    git clone --depth 1 --branch '${sourceId}' 'https://github.com/${mirror}.git' /testbed || {
      git clone 'https://github.com/${mirror}.git' /testbed
      git -C /testbed checkout '${sourceId}'
    }
  fi
  cat > /tmp/bench-testbed-install.sh <<'BENCH_EOF_INSTALL'
set -x
cd /testbed
${pipInstallLines.join("\n")}
${installCmdLines.join("\n")}
python -m pip install 'pytest<9' 'pytest-cov<7' || true
${postInstallPinLines.join("\n")}
BENCH_EOF_INSTALL
  PATH=/opt/testbed-venv/bin:$PATH bash /tmp/bench-testbed-install.sh >/tmp/bench-testbed-install.log 2>&1 || true
  grep -E 'bench-install-cmd-failed' /tmp/bench-testbed-install.log || true
  tail -30 /tmp/bench-testbed-install.log
  PATH=/opt/testbed-venv/bin:$PATH python - <<'BENCH_EOF_VERSIONS' || true
import importlib.metadata as md
for name in ["beautifulsoup4", "html5lib", "lxml", "cryptography", "paramiko", "pytest", "pyarrow", "requests"]:
    try:
        print(f"bench-package-version: {name}=={md.version(name)}")
    except md.PackageNotFoundError:
        pass
BENCH_EOF_VERSIONS
  rm -rf /opt/verifier-venv
  "$BENCH_UV" venv --python 3.11 --seed /opt/verifier-venv
  /opt/verifier-venv/bin/python -m pip install pytest==8.4.1 swebench==4.0.3 datasets==2.16.1 swesmith==0.0.6 >/tmp/bench-pip-verifier.log 2>&1 || tail -5 /tmp/bench-pip-verifier.log
  chmod -R a+rX /opt/verifier-venv
  mkdir -p /usr/local/bin
  ln -sf /opt/testbed-venv/bin/pytest /usr/local/bin/pytest
  printf '%s' "$BENCH_REPO" > /opt/bench-fallback-repo
  printf '%s' "$BENCH_ENV_KEY" > /opt/bench-fallback-env-key
  if [ ! -e /opt/miniconda3/bin/conda ]; then
    mkdir -p /opt/miniconda3/bin
    cat > /opt/miniconda3/bin/activate <<'BENCH_EOF_ACTIVATE'
export PATH=/opt/testbed-venv/bin:/opt/miniconda3/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH
return 0
BENCH_EOF_ACTIVATE
    printf '#!/bin/sh\\nexit 0\\n' > /opt/miniconda3/bin/conda
    chmod +x /opt/miniconda3/bin/conda
  fi${createAgentUser}
fi
if [ -f /opt/bench-fallback-repo ]; then
  sed -i 's#/root/.local/bin/uv run ##g' /tests/test.sh 2>/dev/null || true
fi
if ! command -v patch >/dev/null 2>&1; then
  ${systemPackageInstall(["patch"])}
fi`;
}

export function prepareCommandFor(taskEnv: TaskEnv, provider: ProviderName): string {
  if (taskEnv.envType !== "harbor_swesmith") {
    return basePrepareCommand;
  }
  return `${basePrepareCommand}
${fallbackEnvSetup(taskEnv, provider)}
${deterministicSolveRewrite}
`;
}

// SWE-Smith task images run the agent and verifier as the unprivileged
// ``agent`` user; some test suites (e.g. starlette staticfiles) depend on
// permission semantics that do not hold for root. Run the verifier as
// ``agent`` whenever that user exists and we are root.
export function verifyCommandFor(taskEnv: TaskEnv): string {
  if (taskEnv.envType !== "harbor_swesmith") {
    return verifyCommand;
  }
  const preVerifyLines = guardedShellLines(taskEnv.manifest?.pre_verify_cmds, "pre-verify");
  return `
set +e
${preVerifyLines}
cat > /tmp/bench-verify.sh <<'BENCH_EOF_VERIFY'
export PYTHONPATH=/testbed/src:\${PYTHONPATH:-}
if [ -x /tests/test.sh ] || [ -f /tests/test.sh ]; then
  bash /tests/test.sh
else
  PATH="$HOME/.local/bin:$PATH" pytest /tests/test_outputs.py -rA
fi
BENCH_EOF_VERIFY
chmod 755 /tmp/bench-verify.sh
if [ "$(id -u)" -eq 0 ] && id agent >/dev/null 2>&1; then
  chown -R agent /testbed /tests /solution /logs 2>/dev/null || true
  if command -v runuser >/dev/null 2>&1; then
    cd /testbed && runuser -u agent -- bash /tmp/bench-verify.sh
  else
    cd /testbed && su -s /bin/bash agent -c 'bash /tmp/bench-verify.sh'
  fi
else
  bash /tmp/bench-verify.sh
fi
code=$?
if [ "$code" -ne 0 ] && [ -f /logs/test_output.log ] && grep -Eq '====+ [0-9]+ passed(, [^=]+)* in ' /logs/test_output.log; then
  code=0
fi
if [ "$code" -ne 0 ] && [ -f /logs/test_output.log ] && grep -Eq '^OK( \\([^)]*\\))?$' /logs/test_output.log; then
  code=0
fi
if [ "$code" -ne 0 ] && [ -f /logs/test_output.log ]; then
  echo "===== /logs/test_output.log head ====="
  head -120 /logs/test_output.log
  echo "===== /logs/test_output.log tail ====="
  tail -200 /logs/test_output.log
fi
if [ "$code" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
exit "$code"
`;
}

const MAX_TRANSIENT_TASK_ATTEMPTS = 5;

async function runTask(args: BenchArgs, task: BenchTask): Promise<Record<string, unknown>> {
  const retryErrors: string[] = [];
  let totalElapsedSeconds = 0;
  for (let attempt = 1; attempt <= MAX_TRANSIENT_TASK_ATTEMPTS; attempt += 1) {
    const result = await runTaskAttempt(args, task);
    totalElapsedSeconds += Number(result.elapsed_seconds ?? 0);
    if (attempt > 1) {
      result.task_attempts = attempt;
    }
    if (retryErrors.length > 0) {
      result.transient_retry_errors = retryErrors;
      result.elapsed_seconds = totalElapsedSeconds;
    }
    if (!isTransientTaskFailure(args, result) || attempt === MAX_TRANSIENT_TASK_ATTEMPTS) {
      return result;
    }
    retryErrors.push(String(result.stderr_tail ?? ""));
    console.warn(`retrying ${task.task_id} on ${args.provider} after transient provider transport error`);
    await sleep(attempt * 2000);
  }
  throw new Error("unreachable retry state");
}

function isTransientTaskFailure(args: BenchArgs, result: Record<string, unknown>): boolean {
  const stderr = String(result.stderr_tail ?? "");
  if (result.passed !== false) {
    return false;
  }
  if (args.provider === "vercel") {
    return (
      stderr.includes("StreamError: Stream ended before command finished") ||
      stderr.includes("Error: Unable to connect. Is the computer able to access the url?") ||
      stderr.includes("AbortError: The operation was aborted.") ||
      stderr.includes("TimeoutError: The operation timed out.") ||
      stderr.includes("Error: Status code 410 is not ok")
    );
  }
  if (args.provider === "modal") {
    return (
      stderr.includes("Error: Deadline exceeded") ||
      stderr.includes("Failed to read exec stdio stream") ||
      stderr.includes("ImageJoinStreaming INTERNAL") ||
      stderr.includes("UNAVAILABLE") ||
      stderr.includes("Received RST_STREAM") ||
      stderr.includes("Name resolution failed") ||
      stderr.includes("ECONNREFUSED") ||
      stderr.includes("No connection established")
    );
  }
  return false;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runTaskAttempt(args: BenchArgs, task: BenchTask): Promise<Record<string, unknown>> {
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
  const cpu = Math.max(args.cpu, taskEnv.resources?.cpu ?? 0);
  const memoryGb = Math.max(args.memoryGb, taskEnv.resources?.memoryGb ?? 0);
  const requestedDiskGb = Math.max(args.diskGb, taskEnv.resources?.diskGb ?? 0);
  const diskGb = args.provider === "daytona" ? Math.min(requestedDiskGb, 10) : requestedDiskGb;
  try {
    const activeProvider = makeProvider(args.provider, {
      runtime: taskEnv.runtime ?? args.runtime,
      timeoutSeconds: args.timeoutSeconds,
      cpu,
      memoryGb,
      diskGb,
      dockerfileCommands: taskEnv.dockerfileCommands,
      prewarmProfile: args.prewarmProfile,
      vercelSnapshotId: args.vercelSnapshotId,
      modalImageId: taskEnv.envType === "harbor_swesmith" ? undefined : args.modalImageId,
      daytonaSnapshot: taskEnv.envType === "harbor_swesmith" ? undefined : args.daytonaSnapshot,
      awsMicrovmImageId: args.awsMicrovmImageId,
      awsMicrovmImageVersion: args.awsMicrovmImageVersion,
      awsMicrovmExecutionRoleArn: args.awsMicrovmExecutionRoleArn
    });
    provider = activeProvider;
    await timed("start", () => activeProvider.start());
    await timed("upload", () => writeText(activeProvider, "/tmp/task.tar.gz.b64", task.task_files.content, args.timeoutSeconds));
    const prepare = await timed("prepare", () =>
      activeProvider.run(prepareCommandFor(taskEnv, args.provider), undefined, args.timeoutSeconds)
    );
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
      result = await timed("verify", () => activeProvider.run(verifyCommandFor(taskEnv), taskEnv.verifierCwd, args.timeoutSeconds));
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
    task_repo: taskEnv.repoKey,
    task_cpu: cpu,
    task_memory_gb: memoryGb,
    task_disk_gb: diskGb,
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
    return (
      sum +
      estimateCost(
        args.provider,
        Number(item.elapsed_seconds ?? 0),
        Number(item.task_cpu ?? args.cpu),
        Number(item.task_memory_gb ?? args.memoryGb),
        Number(item.task_disk_gb ?? args.diskGb)
      )
    );
  }, 0);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const tasks = loadTasks(args.dataset, args.taskIndex, args.taskLimit);
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
  if (summary.passed !== summary.task_count) {
    process.exitCode = 1;
  }
}

async function runWithConcurrency(tasks: BenchTask[], args: BenchArgs): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = new Array(tasks.length);
  let nextIndex = 0;
  const workerCount = effectiveWorkerCount(tasks, args);
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

function effectiveWorkerCount(tasks: BenchTask[], args: BenchArgs): number {
  const requested = Math.max(1, Math.min(args.concurrency, tasks.length));
  if (args.provider === "daytona" && tasks.some((task) => task.env_type === "harbor_swesmith")) {
    return 1;
  }
  if (args.provider === "aws-microvm") {
    const memoryCap = Math.max(1, Math.floor(envNumber("AWS_MICROVM_ACCOUNT_MEMORY_GB", 4) / args.memoryGb));
    return Math.min(requested, Number.parseInt(process.env.AWS_MICROVM_MAX_CONCURRENCY ?? "1", 10), memoryCap);
  }
  return requested;
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  return value === undefined ? fallback : Number.parseFloat(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

if (import.meta.main) {
  await main();
}
