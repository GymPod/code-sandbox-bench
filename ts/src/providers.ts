import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { CommandResult } from "./types";

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

export class VercelCliProvider implements Provider {
  private sandboxId: string | undefined;

  constructor(
    private readonly runtime: string,
    private readonly timeoutSeconds: number
  ) {}

  async start(): Promise<void> {
    const output = await $`sandbox create --runtime ${this.runtime} --timeout ${this.timeoutSeconds}s`.quiet();
    const text = `${output.stdout.toString()}${output.stderr.toString()}`;
    const match = text.match(/\b(sbx?_[A-Za-z0-9_-]+)\b/);
    if (!match) {
      throw new Error(`Could not parse Vercel sandbox id from output:\\n${text}`);
    }
    this.sandboxId = match[1];
  }

  async run(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult> {
    if (!this.sandboxId) {
      throw new Error("Vercel sandbox not started");
    }
    const args = cwd
      ? ["sandbox", "exec", "--sudo", "--workdir", cwd, this.sandboxId, "/bin/sh", "-lc", command]
      : ["sandbox", "exec", "--sudo", this.sandboxId, "/bin/sh", "-lc", command];
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
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
    if (this.sandboxId) {
      await $`sandbox stop ${this.sandboxId}`.quiet().nothrow();
      this.sandboxId = undefined;
    }
  }
}

export function makeProvider(name: string, runtime: string, timeoutSeconds: number): Provider {
  if (name === "local") {
    return new LocalProvider();
  }
  if (name === "vercel") {
    return new VercelCliProvider(runtime, timeoutSeconds);
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
