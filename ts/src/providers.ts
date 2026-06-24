import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { CommandResult } from "./types";
import { Daytona, Image as DaytonaImage, type Sandbox as DaytonaSandbox } from "@daytona/sdk";
import { Sandbox as VercelSandbox } from "@vercel/sandbox";
import { ModalClient, type App, type Image as ModalImage, type Sandbox as ModalSandbox } from "modal";
import { AwsMicrovmSandbox, awsMicrovmConfigFromEnv } from "./aws_microvm";

export interface Provider {
  start(): Promise<void>;
  run(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult>;
  stop(): Promise<void>;
}

export type ProviderOptions = {
  runtime: string;
  timeoutSeconds: number;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  dockerfileCommands?: string[];
  prewarmProfile?: string;
  vercelSnapshotId?: string;
  modalImageId?: string;
  daytonaSnapshot?: string;
  awsMicrovmImageId?: string;
  awsMicrovmImageVersion?: string;
  awsMicrovmExecutionRoleArn?: string;
};

export const TERMINALBENCH_DEBIAN_PREWARM_COMMANDS = [
  "ENV DEBIAN_FRONTEND=noninteractive",
  [
    "RUN apt-get update && apt-get install -y --no-install-recommends",
    "build-essential",
    "gfortran",
    "pkg-config",
    "curl",
    "ca-certificates",
    "git",
    "autoconf",
    "automake",
    "libtool",
    "cmake",
    "make",
    "default-jdk",
    "r-base",
    "r-base-dev",
    "libcurl4-openssl-dev",
    "libssl-dev",
    "libxml2-dev",
    "&& rm -rf /var/lib/apt/lists/*"
  ].join(" "),
  "RUN python3 -m pip install --upgrade pip && python3 -m pip install pytest==8.4.1 pandas numpy scipy scikit-learn",
  "RUN Rscript -e \"install.packages('jsonlite', repos='https://cloud.r-project.org')\""
];

export const TERMINALBENCH_VERCEL_PREWARM_COMMAND = `
set -eux
sudo dnf install -y \
  gcc gcc-c++ gcc-gfortran make cmake pkgconf-pkg-config git ca-certificates \
  autoconf automake libtool java-21-amazon-corretto-devel \
  openssl-devel libxml2-devel libcurl-devel python3-pip R R-devel || \
sudo dnf install -y \
  gcc gcc-c++ gcc-gfortran make cmake pkgconf-pkg-config git ca-certificates \
  autoconf automake libtool java-17-amazon-corretto-devel \
  openssl-devel libxml2-devel libcurl-devel python3-pip R R-devel
python3 -m pip install --user --upgrade pip
python3 -m pip install --user pytest==8.4.1 pandas numpy scipy scikit-learn
Rscript -e "install.packages('jsonlite', repos='https://cloud.r-project.org')"
`;

export function debianPrewarmCommands(profile: string | undefined): string[] {
  if (!profile) {
    return [];
  }
  if (profile === "terminalbench-smoke") {
    return TERMINALBENCH_DEBIAN_PREWARM_COMMANDS;
  }
  throw new Error(`Unsupported prewarm profile: ${profile}`);
}

export function vercelPrewarmCommand(profile: string | undefined): string {
  if (!profile) {
    return "";
  }
  if (profile === "terminalbench-smoke") {
    return TERMINALBENCH_VERCEL_PREWARM_COMMAND;
  }
  throw new Error(`Unsupported prewarm profile: ${profile}`);
}

export class LocalProvider implements Provider {
  private readonly root = mkdtempSync(join(tmpdir(), "code-sandbox-bench-ts-"));

  async start(): Promise<void> {}

  async run(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult> {
    const workdir = cwd ? join(this.root, cwd.replace(/^\//, "")) : this.root;
    await $`mkdir -p ${workdir}`.quiet();
    const proc = Bun.spawn(["/bin/sh", "-lc", this.localize(command)], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => proc.kill(), timeoutSeconds * 1000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    clearTimeout(timeout);
    return { stdout, stderr, returnCode: exitCode };
  }

  async stop(): Promise<void> {
    rmSync(this.root, { recursive: true, force: true });
  }

  private localize(command: string): string {
    return command
      .replace(/(?<![A-Za-z0-9_.-])\/workspace\b/g, join(this.root, "workspace"))
      .replace(/(?<![A-Za-z0-9_.-])\/testbed\b/g, join(this.root, "testbed"))
      .replace(/(?<![A-Za-z0-9_.-])\/tests\b/g, join(this.root, "tests"))
      .replace(/(?<![A-Za-z0-9_.-])\/solution\b/g, join(this.root, "solution"))
      .replace(/(?<![A-Za-z0-9_.-])\/logs\b/g, join(this.root, "logs"))
      .replace(/(?<![A-Za-z0-9_.-])\/tmp\//g, `${join(this.root, "tmp")}/`);
  }
}

export class VercelSdkProvider implements Provider {
  private sandbox: VercelSandbox | undefined;

  constructor(
    private readonly runtime: string,
    private readonly timeoutSeconds: number,
    private readonly cpu: number,
    private readonly snapshotId: string | undefined
  ) {}

  async start(): Promise<void> {
    this.sandbox = await VercelSandbox.create({
      ...vercelCredentials(),
      ...(this.snapshotId
        ? { source: { type: "snapshot" as const, snapshotId: this.snapshotId } }
        : { runtime: this.runtime }),
      timeout: this.timeoutSeconds * 1000,
      resources: { vcpus: this.cpu }
    });
  }

  async run(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult> {
    if (!this.sandbox) {
      throw new Error("Vercel sandbox not started");
    }
    const commandProcess = await this.sandbox.runCommand({
      cmd: "/bin/sh",
      args: ["-lc", command],
      cwd,
      sudo: true,
      detached: true,
      signal: AbortSignal.timeout(60_000)
    });
    const started = performance.now();
    while ((performance.now() - started) / 1000 < timeoutSeconds) {
      const remainingMs = Math.max(1000, timeoutSeconds * 1000 - (performance.now() - started));
      const waitMs = Math.min(60_000, remainingMs);
      try {
        const finished = await commandProcess.wait({ signal: AbortSignal.timeout(waitMs) });
        const [stdout, stderr] = await Promise.all([this.commandOutput(finished, "stdout"), this.commandOutput(finished, "stderr")]);
        return { stdout, stderr, returnCode: finished.exitCode };
      } catch {
        await sleep(2000);
      }
    }
    await commandProcess.kill("SIGTERM", { abortSignal: AbortSignal.timeout(60_000) }).catch(() => {});
    return { stdout: "", stderr: `Command timed out after ${timeoutSeconds}s`, returnCode: 124 };
  }

  private async commandOutput(
    command: { stdout(opts?: { signal?: AbortSignal }): Promise<string>; stderr(opts?: { signal?: AbortSignal }): Promise<string> },
    stream: "stdout" | "stderr"
  ): Promise<string> {
    try {
      return await command[stream]({ signal: AbortSignal.timeout(60_000) });
    } catch {
      return "";
    }
  }

  async stop(): Promise<void> {
    if (this.sandbox) {
      await this.sandbox.stop({ blocking: true });
      this.sandbox = undefined;
    }
  }
}

function noCompressionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("accept-encoding", "identity");
  return fetch(input, { ...init, headers });
}

const vercelFetch = Object.assign(noCompressionFetch, { preconnect: fetch.preconnect }) as typeof fetch;

export function vercelCredentials():
  | { token: string; teamId: string; projectId: string; fetch: typeof fetch }
  | Record<string, never> {
  const token = process.env.VERCEL_TOKEN ?? process.env.VERCEL_ACCESS_TOKEN ?? process.env.VERCEL_API_KEY;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token || teamId || projectId) {
    if (!token || !teamId || !projectId) {
      throw new Error("Vercel SDK requires VERCEL_TOKEN or VERCEL_ACCESS_TOKEN, plus VERCEL_TEAM_ID and VERCEL_PROJECT_ID");
    }
    return { token, teamId, projectId, fetch: vercelFetch };
  }
  return {};
}

export class ModalProvider implements Provider {
  private readonly client = new ModalClient();
  private app: App | undefined;
  private sandbox: ModalSandbox | undefined;

  constructor(
    private readonly image: string,
    private readonly timeoutSeconds: number,
    private readonly cpu: number,
    private readonly memoryGb: number,
    private readonly dockerfileCommands: string[] | undefined,
    private readonly prewarmProfile: string | undefined,
    private readonly modalImageId: string | undefined
  ) {}

  async start(): Promise<void> {
    this.app = await this.client.apps.fromName("code-sandbox-bench", { createIfMissing: true });
    let image: ModalImage = this.modalImageId
      ? await this.client.images.fromId(this.modalImageId)
      : this.client.images.fromRegistry(this.image);
    const commands = this.dockerfileCommands ?? debianPrewarmCommands(this.prewarmProfile);
    if (!this.modalImageId && commands.length > 0) {
      image = await image.dockerfileCommands(commands).build(this.app);
    }
    this.sandbox = await this.client.sandboxes.create(this.app, image, {
      command: ["sleep", "infinity"],
      timeoutMs: this.timeoutSeconds * 1000,
      cpu: this.cpu / 2,
      memoryMiB: this.memoryGb * 1024
    });
  }

  async run(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult> {
    if (!this.sandbox) {
      throw new Error("Modal sandbox not started");
    }
    return await withTimeout(
      (async () => {
        const process = await this.sandbox!.exec(["/bin/sh", "-lc", command], {
          workdir: cwd,
          timeoutMs: timeoutSeconds * 1000,
          mode: "text"
        });
        const [stdout, stderr, returnCode] = await Promise.all([
          process.stdout.readText(),
          process.stderr.readText(),
          process.wait()
        ]);
        return { stdout, stderr, returnCode };
      })(),
      (timeoutSeconds + 30) * 1000,
      `Modal command timed out after ${timeoutSeconds}s`
    );
  }

  async stop(): Promise<void> {
    if (this.sandbox) {
      await this.sandbox.terminate();
      this.sandbox = undefined;
    }
  }
}

export class DaytonaProvider implements Provider {
  private readonly client = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET || undefined
  });
  private sandbox: DaytonaSandbox | undefined;

  constructor(
    private readonly image: string,
    private readonly timeoutSeconds: number,
    private readonly cpu: number,
    private readonly memoryGb: number,
    private readonly diskGb: number,
    private readonly dockerfileCommands: string[] | undefined,
    private readonly prewarmProfile: string | undefined,
    private readonly daytonaSnapshot: string | undefined
  ) {}

  async start(): Promise<void> {
    const sandboxName = `code-sandbox-bench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const baseParams = {
      name: sandboxName,
      labels: {
        app: "code-sandbox-bench"
      },
      resources: {
        cpu: this.cpu,
        memory: this.memoryGb,
        disk: this.diskGb
      },
      autoStopInterval: 0,
      autoDeleteInterval: 0
    };
    await retryDaytonaStart(async (attempt) => {
      const params = {
        ...baseParams,
        name: attempt === 1 ? sandboxName : `${sandboxName}-${attempt}`
      };
      if (this.daytonaSnapshot) {
        this.sandbox = await this.client.create({ ...params, snapshot: this.daytonaSnapshot }, { timeout: this.timeoutSeconds });
        return;
      }
      const commands = this.dockerfileCommands ?? debianPrewarmCommands(this.prewarmProfile);
      this.sandbox = await this.client.create(
        {
          ...params,
          image: commands.length > 0 ? DaytonaImage.base(this.image).dockerfileCommands(commands) : this.image
        },
        { timeout: this.timeoutSeconds }
      );
    });
  }

  async run(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult> {
    if (!this.sandbox) {
      throw new Error("Daytona sandbox not started");
    }
    return await withTimeout(
      (async () => {
        const response = await this.sandbox!.process.executeCommand(command, cwd, undefined, timeoutSeconds);
        return {
          stdout: response.artifacts?.stdout ?? response.result ?? "",
          stderr: "",
          returnCode: response.exitCode ?? 0
        };
      })(),
      (timeoutSeconds + 30) * 1000,
      `Daytona command timed out after ${timeoutSeconds}s`
    );
  }

  async stop(): Promise<void> {
    if (this.sandbox) {
      await this.client.delete(this.sandbox);
      this.sandbox = undefined;
    }
    await this.client[Symbol.asyncDispose]();
  }
}

export class AwsMicrovmProvider implements Provider {
  private sandbox: AwsMicrovmSandbox | undefined;

  constructor(
    private readonly timeoutSeconds: number,
    private readonly imageIdentifier: string | undefined,
    private readonly imageVersion: string | undefined,
    private readonly executionRoleArn: string | undefined
  ) {}

  async start(): Promise<void> {
    this.sandbox = new AwsMicrovmSandbox(
      awsMicrovmConfigFromEnv({
        imageIdentifier: this.imageIdentifier,
        imageVersion: this.imageVersion,
        executionRoleArn: this.executionRoleArn,
        timeoutSeconds: this.timeoutSeconds
      })
    );
    await this.sandbox.start();
  }

  async run(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult> {
    if (!this.sandbox) {
      throw new Error("AWS MicroVM sandbox not started");
    }
    return await this.sandbox.run(command, cwd, timeoutSeconds);
  }

  async stop(): Promise<void> {
    if (this.sandbox) {
      await this.sandbox.stop();
      this.sandbox = undefined;
    }
  }
}

async function retryDaytonaStart(action: (attempt: number) => Promise<void>): Promise<void> {
  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await action(attempt);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableDaytonaStartError(error)) {
        throw error;
      }
      await sleep(attempt * 2000);
    }
  }
  throw lastError;
}

function isRetryableDaytonaStartError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /502 Bad Gateway|Sandbox with name .* already exists|rate limit|RESOURCE_EXHAUSTED|ECONNRESET|ETIMEDOUT/i.test(message);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

export function makeProvider(
  name: string,
  options: ProviderOptions
): Provider {
  if (name === "local") {
    return new LocalProvider();
  }
  if (name === "vercel") {
    return new VercelSdkProvider(options.runtime, options.timeoutSeconds, options.cpu, options.vercelSnapshotId);
  }
  if (name === "modal") {
    return new ModalProvider(
      options.runtime,
      options.timeoutSeconds,
      options.cpu,
      options.memoryGb,
      options.dockerfileCommands,
      options.prewarmProfile,
      options.modalImageId
    );
  }
  if (name === "daytona") {
    return new DaytonaProvider(
      options.runtime,
      options.timeoutSeconds,
      options.cpu,
      options.memoryGb,
      options.diskGb,
      options.dockerfileCommands,
      options.prewarmProfile,
      options.daytonaSnapshot
    );
  }
  if (name === "aws-microvm") {
    return new AwsMicrovmProvider(
      options.timeoutSeconds,
      options.awsMicrovmImageId,
      options.awsMicrovmImageVersion,
      options.awsMicrovmExecutionRoleArn
    );
  }
  throw new Error(`Unsupported TypeScript provider: ${name}`);
}

export async function writeText(provider: Provider, remotePath: string, content: string, timeoutSeconds: number): Promise<void> {
  await provider.run(`mkdir -p $(dirname ${shellQuote(remotePath)}) && : > ${shellQuote(remotePath)}`, undefined, timeoutSeconds);
  for (let offset = 0; offset < content.length; offset += 30000) {
    const chunk = content.slice(offset, offset + 30000);
    const result = await provider.run(`printf %s ${shellQuote(chunk)} >> ${shellQuote(remotePath)}`, undefined, timeoutSeconds);
    if (result.returnCode !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
