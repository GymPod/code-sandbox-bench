import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { CommandResult } from "./types";
import { Daytona, type Sandbox as DaytonaSandbox } from "@daytona/sdk";
import { Sandbox as VercelSandbox } from "@vercel/sandbox";
import { ModalClient, type App, type Sandbox as ModalSandbox } from "modal";

export interface Provider {
  start(): Promise<void>;
  run(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult>;
  stop(): Promise<void>;
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
      .replace(/(?<![A-Za-z0-9_.-])\/tests\b/g, join(this.root, "tests"))
      .replace(/(?<![A-Za-z0-9_.-])\/logs\b/g, join(this.root, "logs"))
      .replace(/(?<![A-Za-z0-9_.-])\/tmp\//g, `${join(this.root, "tmp")}/`);
  }
}

export class VercelSdkProvider implements Provider {
  private sandbox: VercelSandbox | undefined;

  constructor(
    private readonly runtime: string,
    private readonly timeoutSeconds: number,
    private readonly cpu: number
  ) {}

  async start(): Promise<void> {
    this.sandbox = await VercelSandbox.create({
      ...vercelCredentials(),
      runtime: this.runtime,
      timeout: this.timeoutSeconds * 1000,
      resources: { vcpus: this.cpu }
    });
  }

  async run(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult> {
    if (!this.sandbox) {
      throw new Error("Vercel sandbox not started");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
      const process = await this.sandbox.runCommand({
        cmd: "/bin/sh",
        args: ["-lc", command],
        cwd,
        sudo: true,
        signal: controller.signal
      });
      const [stdout, stderr] = await Promise.all([process.stdout(), process.stderr()]);
      return { stdout, stderr, returnCode: process.exitCode };
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop(): Promise<void> {
    if (this.sandbox) {
      await this.sandbox.stop({ blocking: true });
      this.sandbox = undefined;
    }
  }
}

function vercelCredentials(): { token: string; teamId: string; projectId: string } | Record<string, never> {
  const token = process.env.VERCEL_TOKEN ?? process.env.VERCEL_ACCESS_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token || teamId || projectId) {
    if (!token || !teamId || !projectId) {
      throw new Error("Vercel SDK requires VERCEL_TOKEN or VERCEL_ACCESS_TOKEN, plus VERCEL_TEAM_ID and VERCEL_PROJECT_ID");
    }
    return { token, teamId, projectId };
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
    private readonly memoryGb: number
  ) {}

  async start(): Promise<void> {
    this.app = await this.client.apps.fromName("code-sandbox-bench", { createIfMissing: true });
    const image = this.client.images.fromRegistry(this.image);
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
    const process = await this.sandbox.exec(["/bin/sh", "-lc", command], {
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
    private readonly diskGb: number
  ) {}

  async start(): Promise<void> {
    this.sandbox = await this.client.create(
      {
        image: this.image,
        resources: {
          cpu: this.cpu,
          memory: this.memoryGb,
          disk: this.diskGb
        },
        autoStopInterval: 0,
        autoDeleteInterval: 0
      },
      { timeout: this.timeoutSeconds }
    );
  }

  async run(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult> {
    if (!this.sandbox) {
      throw new Error("Daytona sandbox not started");
    }
    const response = await this.sandbox.process.executeCommand(command, cwd, undefined, timeoutSeconds);
    return {
      stdout: response.artifacts?.stdout ?? response.result ?? "",
      stderr: "",
      returnCode: response.exitCode ?? 0
    };
  }

  async stop(): Promise<void> {
    if (this.sandbox) {
      await this.client.delete(this.sandbox);
      this.sandbox = undefined;
    }
    await this.client[Symbol.asyncDispose]();
  }
}

export function makeProvider(
  name: string,
  runtime: string,
  timeoutSeconds: number,
  cpu: number,
  memoryGb: number,
  diskGb: number
): Provider {
  if (name === "local") {
    return new LocalProvider();
  }
  if (name === "vercel") {
    return new VercelSdkProvider(runtime, timeoutSeconds, cpu);
  }
  if (name === "modal") {
    return new ModalProvider(runtime, timeoutSeconds, cpu, memoryGb);
  }
  if (name === "daytona") {
    return new DaytonaProvider(runtime, timeoutSeconds, cpu, memoryGb, diskGb);
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
