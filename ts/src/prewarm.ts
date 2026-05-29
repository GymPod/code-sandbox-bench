import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Daytona, Image as DaytonaImage } from "@daytona/sdk";
import { ModalClient } from "modal";
import { Sandbox as VercelSandbox } from "@vercel/sandbox";
import { debianPrewarmCommands, vercelCredentials, vercelPrewarmCommand } from "./providers";

type PrewarmArgs = {
  provider: "vercel" | "modal" | "daytona";
  runtime: string;
  profile: string;
  name: string;
  timeoutSeconds: number;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  force: boolean;
  output?: string;
};

function parseArgs(argv: string[]): PrewarmArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  return {
    provider: (values.get("--provider") ?? "modal") as "vercel" | "modal" | "daytona",
    runtime: values.get("--runtime") ?? "python:3.13",
    profile: values.get("--profile") ?? "terminalbench-smoke",
    name: values.get("--name") ?? "code-sandbox-bench-terminalbench-smoke",
    timeoutSeconds: Number.parseInt(values.get("--timeout-seconds") ?? "1800", 10),
    cpu: Number.parseInt(values.get("--cpu") ?? "2", 10),
    memoryGb: Number.parseInt(values.get("--memory-gb") ?? "4", 10),
    diskGb: Number.parseInt(values.get("--disk-gb") ?? "10", 10),
    force: values.get("--force") === "true",
    output: values.get("--output")
  };
}

async function prewarmVercel(args: PrewarmArgs): Promise<Record<string, unknown>> {
  const sandbox = await VercelSandbox.create({
    ...vercelCredentials(),
    runtime: args.runtime,
    timeout: args.timeoutSeconds * 1000,
    resources: { vcpus: args.cpu }
  });
  try {
    const command = vercelPrewarmCommand(args.profile);
    const process = await sandbox.runCommand({
      cmd: "/bin/sh",
      args: ["-lc", command],
      sudo: true
    });
    const [stdout, stderr] = await Promise.all([process.stdout(), process.stderr()]);
    if (process.exitCode !== 0) {
      throw new Error(`Vercel prewarm failed with ${process.exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    }
    const snapshot = await sandbox.snapshot({ expiration: 0 });
    return {
      provider: "vercel",
      profile: args.profile,
      runtime: args.runtime,
      vercel_snapshot_id: snapshot.snapshotId,
      snapshot_status: snapshot.status,
      env: `VERCEL_SNAPSHOT_ID=${snapshot.snapshotId}`
    };
  } catch (error) {
    await sandbox.stop({ blocking: true }).catch(() => undefined);
    throw error;
  }
}

async function prewarmModal(args: PrewarmArgs): Promise<Record<string, unknown>> {
  const client = new ModalClient();
  const app = await client.apps.fromName("code-sandbox-bench", { createIfMissing: true });
  const image = await client.images
    .fromRegistry(args.runtime)
    .dockerfileCommands(debianPrewarmCommands(args.profile))
    .build(app);
  return {
    provider: "modal",
    profile: args.profile,
    runtime: args.runtime,
    modal_image_id: image.imageId,
    env: `MODAL_IMAGE_ID=${image.imageId}`
  };
}

async function prewarmDaytona(args: PrewarmArgs): Promise<Record<string, unknown>> {
  const daytona = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET || undefined
  });
  try {
    if (args.force) {
      try {
        const existing = await daytona.snapshot.get(args.name);
        await daytona.snapshot.delete(existing);
      } catch {
        // Snapshot did not exist or was already unavailable.
      }
    }
    const image = DaytonaImage.base(args.runtime).dockerfileCommands(debianPrewarmCommands(args.profile));
    const snapshot = await daytona.snapshot.create(
      {
        name: args.name,
        image,
        resources: {
          cpu: args.cpu,
          memory: args.memoryGb,
          disk: args.diskGb
        }
      },
      {
        timeout: args.timeoutSeconds,
        onLogs: (chunk) => process.stdout.write(chunk)
      }
    );
    return {
      provider: "daytona",
      profile: args.profile,
      runtime: args.runtime,
      daytona_snapshot: snapshot.name,
      snapshot_state: snapshot.state,
      env: `DAYTONA_SNAPSHOT=${snapshot.name}`
    };
  } finally {
    await daytona[Symbol.asyncDispose]();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const result =
    args.provider === "vercel"
      ? await prewarmVercel(args)
      : args.provider === "modal"
        ? await prewarmModal(args)
        : await prewarmDaytona(args);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, output);
  }
  console.log(output);
}

await main();
