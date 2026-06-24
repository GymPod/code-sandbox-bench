import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Daytona, Image as DaytonaImage } from "@daytona/sdk";
import { ModalClient } from "modal";
import { Sandbox as VercelSandbox } from "@vercel/sandbox";
import {
  CreateMicrovmImageCommand,
  DeleteMicrovmImageCommand,
  GetMicrovmImageCommand,
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand
} from "@aws-sdk/client-lambda-microvms";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { debianPrewarmCommands, vercelCredentials, vercelPrewarmCommand } from "./providers";

type PrewarmArgs = {
  provider: "vercel" | "modal" | "daytona" | "aws-microvm";
  runtime: string;
  profile: string;
  name: string;
  timeoutSeconds: number;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  force: boolean;
  awsRegion: string;
  awsBucket?: string;
  awsArtifactPrefix: string;
  awsBaseImageArn?: string;
  awsBuildRoleArn?: string;
  output?: string;
};

function parseArgs(argv: string[]): PrewarmArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  return {
    provider: (values.get("--provider") ?? "modal") as "vercel" | "modal" | "daytona" | "aws-microvm",
    runtime: values.get("--runtime") ?? "python:3.13",
    profile: values.get("--profile") ?? "terminalbench-smoke",
    name: values.get("--name") ?? "code-sandbox-bench-terminalbench-smoke",
    timeoutSeconds: Number.parseInt(values.get("--timeout-seconds") ?? "1800", 10),
    cpu: Number.parseInt(values.get("--cpu") ?? "2", 10),
    memoryGb: Number.parseInt(values.get("--memory-gb") ?? "4", 10),
    diskGb: Number.parseInt(values.get("--disk-gb") ?? "10", 10),
    force: values.get("--force") === "true",
    awsRegion: values.get("--aws-region") ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    awsBucket: values.get("--aws-bucket") ?? process.env.AWS_MICROVM_ARTIFACT_BUCKET,
    awsArtifactPrefix: values.get("--aws-artifact-prefix") ?? process.env.AWS_MICROVM_ARTIFACT_PREFIX ?? "code-sandbox-bench/aws-microvm",
    awsBaseImageArn: values.get("--aws-base-image-arn") ?? process.env.AWS_MICROVM_BASE_IMAGE_ARN,
    awsBuildRoleArn: values.get("--aws-build-role-arn") ?? process.env.AWS_MICROVM_BUILD_ROLE_ARN,
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

async function prewarmAwsMicrovm(args: PrewarmArgs): Promise<Record<string, unknown>> {
  if (!args.awsBucket) {
    throw new Error("AWS MicroVM prewarm requires --aws-bucket or AWS_MICROVM_ARTIFACT_BUCKET");
  }
  if (!args.awsBuildRoleArn) {
    throw new Error("AWS MicroVM prewarm requires --aws-build-role-arn or AWS_MICROVM_BUILD_ROLE_ARN");
  }
  const imageName = sanitizeAwsMicrovmImageName(args.name);
  const archivePath = await packageAwsMicrovmRunner();
  const s3 = new S3Client({ region: args.awsRegion });
  const lambdaMicrovms = new LambdaMicrovmsClient({ region: args.awsRegion });
  const key = `${args.awsArtifactPrefix.replace(/\/+$/, "")}/${imageName}-${Date.now().toString(36)}.zip`;
  try {
    if (args.force) {
      await deleteAwsMicrovmImageIfExists(lambdaMicrovms, imageName);
    }
    await s3.send(
      new PutObjectCommand({
        Bucket: args.awsBucket,
        Key: key,
        Body: createReadStream(archivePath),
        ContentType: "application/zip"
      })
    );
    const codeArtifactUri = `s3://${args.awsBucket}/${key}`;
    const baseImageArn = args.awsBaseImageArn ?? `arn:aws:lambda:${args.awsRegion}:aws:microvm-image:al2023-1`;
    const created = await lambdaMicrovms.send(
      new CreateMicrovmImageCommand({
        name: imageName,
        codeArtifact: { uri: codeArtifactUri },
        baseImageArn,
        buildRoleArn: args.awsBuildRoleArn,
        description: `code-sandbox-bench ${args.profile} runner`,
        cpuConfigurations: [{ architecture: "ARM_64" }],
        resources: [{ minimumMemoryInMiB: args.memoryGb * 1024 }],
        hooks: awsMicrovmHooks(args),
        tags: {
          app: "code-sandbox-bench",
          provider: "aws-microvm",
          profile: args.profile
        }
      })
    );
    const imageArn = required(created.imageArn, "CreateMicrovmImage did not return imageArn");
    const image = await waitForAwsMicrovmImage(lambdaMicrovms, imageArn, args.timeoutSeconds);
    return {
      provider: "aws-microvm",
      profile: args.profile,
      runtime: args.runtime,
      region: args.awsRegion,
      artifact_uri: codeArtifactUri,
      aws_microvm_image_id: imageArn,
      aws_microvm_image_version: image.latestActiveImageVersion,
      image_state: image.state,
      env: [
        `AWS_REGION=${args.awsRegion}`,
        `AWS_MICROVM_IMAGE_ID=${imageArn}`,
        image.latestActiveImageVersion ? `AWS_MICROVM_IMAGE_VERSION=${image.latestActiveImageVersion}` : undefined
      ].filter(Boolean).join("\n")
    };
  } finally {
    rmSync(dirname(archivePath), { recursive: true, force: true });
  }
}

async function deleteAwsMicrovmImageIfExists(client: LambdaMicrovmsClient, imageIdentifier: string): Promise<void> {
  const resolvedImageIdentifier = await resolveAwsMicrovmImageIdentifier(client, imageIdentifier);
  if (!resolvedImageIdentifier) {
    return;
  }
  try {
    await client.send(new DeleteMicrovmImageCommand({ imageIdentifier: resolvedImageIdentifier }));
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceNotFoundException") {
      return;
    }
    throw error;
  }
  const started = performance.now();
  while ((performance.now() - started) / 1000 < 180) {
    try {
      const image = await client.send(new GetMicrovmImageCommand({ imageIdentifier: resolvedImageIdentifier }));
      if (image.state === "DELETED") {
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "ResourceNotFoundException") {
        return;
      }
      throw error;
    }
    await sleep(5000);
  }
  throw new Error(`Timed out waiting for AWS MicroVM image deletion: ${resolvedImageIdentifier}`);
}

async function resolveAwsMicrovmImageIdentifier(
  client: LambdaMicrovmsClient,
  imageIdentifier: string
): Promise<string | undefined> {
  if (imageIdentifier.startsWith("arn:")) {
    return imageIdentifier;
  }
  const listed = await client.send(new ListMicrovmImagesCommand({ nameFilter: imageIdentifier, maxResults: 50 }));
  return listed.items?.find((item) => item.name === imageIdentifier)?.imageArn;
}

function awsMicrovmHooks(args: PrewarmArgs) {
  if (process.env.AWS_MICROVM_ENABLE_HOOKS !== "1" && process.env.AWS_MICROVM_ENABLE_HOOKS !== "true") {
    return undefined;
  }
  return {
    port: 8080,
    microvmImageHooks: {
      ready: "ENABLED" as const,
      readyTimeoutInSeconds: Math.min(args.timeoutSeconds, 600),
      validate: "ENABLED" as const,
      validateTimeoutInSeconds: Math.min(args.timeoutSeconds, 600)
    },
    microvmHooks: {
      run: "ENABLED" as const,
      runTimeoutInSeconds: 60,
      resume: "ENABLED" as const,
      resumeTimeoutInSeconds: 60,
      terminate: "ENABLED" as const,
      terminateTimeoutInSeconds: 30
    }
  };
}

async function packageAwsMicrovmRunner(): Promise<string> {
  const source = resolve(import.meta.dir, "../aws-microvm-runner");
  const workdir = mkdtempSync(join(tmpdir(), "code-sandbox-bench-aws-microvm-"));
  const staging = join(workdir, "runner");
  const archivePath = join(workdir, "runner.zip");
  await cp(source, staging, { recursive: true });
  await runZip(staging, archivePath);
  const info = await stat(archivePath);
  if (!info.size) {
    throw new Error("AWS MicroVM runner archive is empty");
  }
  return archivePath;
}

async function runZip(cwd: string, archivePath: string): Promise<void> {
  const proc = Bun.spawn(["zip", "-qr", archivePath, "."], {
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`zip failed with ${exitCode}\n${stdout}\n${stderr}`.trim());
  }
}

async function waitForAwsMicrovmImage(
  client: LambdaMicrovmsClient,
  imageIdentifier: string,
  timeoutSeconds: number
): Promise<{ state?: string; latestActiveImageVersion?: string }> {
  const started = performance.now();
  while ((performance.now() - started) / 1000 < timeoutSeconds) {
    const image = await client.send(new GetMicrovmImageCommand({ imageIdentifier }));
    if (image.state === "CREATED" || image.state === "UPDATED") {
      return image;
    }
    if (image.state === "CREATE_FAILED" || image.state === "UPDATE_FAILED" || image.state === "DELETE_FAILED") {
      throw new Error(`AWS MicroVM image build failed with state ${image.state}`);
    }
    await sleep(10_000);
  }
  throw new Error(`AWS MicroVM image was not ready after ${timeoutSeconds}s`);
}

function sanitizeAwsMicrovmImageName(value: string): string {
  return value.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 64) || `code-sandbox-bench-${Date.now().toString(36)}`;
}

function required(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const result =
    args.provider === "vercel"
      ? await prewarmVercel(args)
      : args.provider === "modal"
        ? await prewarmModal(args)
        : args.provider === "daytona"
          ? await prewarmDaytona(args)
          : await prewarmAwsMicrovm(args);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, output);
  }
  console.log(output);
}

await main();
