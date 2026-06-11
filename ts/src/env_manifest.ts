import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type RepoResources = {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
};

export type EnvManifestEntry = {
  owner: string;
  repo: string;
  commit: string;
  mirror: string;
  docker_image?: string;
  python_version: string;
  install_cmds: string[];
  pre_install_pip: string[];
  extra_pip: string[];
  system_packages: string[];
  resources?: RepoResources;
  notes?: string;
};

type EnvManifestFile = {
  repos: Record<string, EnvManifestEntry>;
};

export const DEFAULT_ENV_MANIFESTS_PATH = resolve(import.meta.dir, "../../data/swesmith_env_manifests.json");

const manifestCache = new Map<string, Record<string, EnvManifestEntry>>();

export function loadEnvManifests(path: string = DEFAULT_ENV_MANIFESTS_PATH): Record<string, EnvManifestEntry> {
  let repos = manifestCache.get(path);
  if (!repos) {
    try {
      repos = (JSON.parse(readFileSync(path, "utf8")) as EnvManifestFile).repos ?? {};
    } catch {
      repos = {};
    }
    manifestCache.set(path, repos);
  }
  return repos;
}
