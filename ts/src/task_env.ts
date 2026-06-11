import { gunzipSync } from "node:zlib";
import { loadEnvManifests } from "./env_manifest";
import type { BenchTask, ProviderName, TaskEnv } from "./types";

export function resolveTaskEnv(task: BenchTask, defaultRuntime: string, provider: ProviderName): TaskEnv {
  if (task.env_type === "harbor_swesmith") {
    const dockerfile = readArchiveText(task, "environment/Dockerfile");
    const dockerImage = dockerfile ? parseDockerfileFrom(dockerfile) : undefined;
    const dockerfileCommands = dockerfile ? providerDockerfileCommands(task, dockerfile, provider) : undefined;
    const taskToml = readArchiveText(task, "task.toml");
    const repoKey = taskToml ? parseTomlValue(taskToml, "repository")?.split("/", 2)[1] : undefined;
    const sourceId = taskToml ? parseTomlValue(taskToml, "source_id") : undefined;
    const manifest = repoKey ? loadEnvManifests()[repoKey] : undefined;
    return {
      envType: task.env_type,
      dataSource: task.data_source,
      workdir: "/testbed",
      verifierCwd: "/testbed",
      runtime: providerSupportsDockerRuntime(provider) ? dockerImage : defaultRuntime,
      dockerImage,
      dockerfileCommands,
      dockerfilePath: dockerfile ? "environment/Dockerfile" : undefined,
      repoKey,
      sourceId,
      manifest,
      resources: manifest?.resources
    };
  }
  return {
    envType: task.env_type ?? "terminalbench",
    dataSource: task.data_source,
    workdir: "/workspace",
    verifierCwd: "/workspace",
    runtime: defaultRuntime
  };
}

export function providerSupportsDockerRuntime(provider: ProviderName): boolean {
  return provider === "modal" || provider === "daytona";
}

function parseTomlValue(toml: string, key: string): string | undefined {
  return toml.match(new RegExp(`^${key} = "([^"]+)"`, "m"))?.[1];
}

function parseDockerfileFrom(dockerfile: string): string | undefined {
  return dockerfile
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("FROM "))
    ?.split(/\s+/)[1];
}

function providerDockerfileCommands(task: BenchTask, dockerfile: string, provider: ProviderName): string[] | undefined {
  if (provider === "daytona") {
    return taskDockerfileCommands(task, dockerfile);
  }
  return undefined;
}

function taskDockerfileCommands(task: BenchTask, dockerfile: string): string[] {
  const commands = parseDockerfileInstructions(dockerfile).filter((command) => !command.startsWith("FROM "));
  const hackblockFiles = [
    ["hackblock/proxy.py", readArchiveText(task, "environment/hackblock/proxy.py")],
    ["hackblock/99-hackblock-v4.sh", readArchiveText(task, "environment/hackblock/99-hackblock-v4.sh")]
  ] as const;
  const providerCommands = commands.flatMap((command) => {
    if (command.startsWith("COPY hackblock/ ")) {
      return [inlineHackblockFiles(hackblockFiles)];
    }
    return [command];
  });
  return [...providerCommands, "USER root", "ENV HOME=/root", "WORKDIR /testbed"];
}

function parseDockerfileInstructions(dockerfile: string): string[] {
  const commands: string[] = [];
  let current = "";
  for (const rawLine of dockerfile.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.trimStart().startsWith("#")) {
      continue;
    }
    const continued = line.endsWith("\\");
    current += current ? `\n${line}` : line;
    if (continued) {
      continue;
    }
    commands.push(current.trim());
    current = "";
  }
  if (current.trim()) {
    commands.push(current.trim());
  }
  return commands;
}

function inlineHackblockFiles(files: readonly (readonly [string, string | undefined])[]): string {
  const payload = Object.fromEntries(files.map(([path, content]) => [path, content ?? ""]));
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `RUN python3 - <<'PY'\nimport base64, json, pathlib\nfiles = json.loads(base64.b64decode("${encoded}").decode())\nfor name, content in files.items():\n    path = pathlib.Path("/opt") / name\n    path.parent.mkdir(parents=True, exist_ok=True)\n    path.write_text(content)\nPY`;
}

function readArchiveText(task: BenchTask, path: string): string | undefined {
  if (task.task_files.encoding !== "tar.gz+base64") {
    return undefined;
  }
  const tar = gunzipSync(Buffer.from(task.task_files.content, "base64"));
  for (let offset = 0; offset + 512 <= tar.length; offset += 512) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      return undefined;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const fileStart = offset + 512;
    const fileEnd = fileStart + size;
    if (fullName === path) {
      return tar.subarray(fileStart, fileEnd).toString("utf8");
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return undefined;
}
