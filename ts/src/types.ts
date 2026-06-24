export type BenchTask = {
  task_id: string;
  prompt: string;
  instruction: string;
  task_files: {
    encoding: string;
    content: string;
  };
  data_source?: string;
  env_type?: string;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  returnCode: number;
};

export type ProviderName = "local" | "vercel" | "modal" | "daytona" | "aws-microvm";
export type RunMode = "cold" | "warm";
export type RunKind = "verifier" | "solve";

export type TaskEnv = {
  envType: string;
  dataSource?: string;
  workdir: string;
  verifierCwd: string;
  runtime?: string;
  dockerImage?: string;
  dockerfileCommands?: string[];
  dockerfilePath?: string;
  repoKey?: string;
  sourceId?: string;
  manifest?: import("./env_manifest").EnvManifestEntry;
  resources?: import("./env_manifest").RepoResources;
};

export type BenchArgs = {
  provider: ProviderName;
  mode: RunMode;
  dataset: string;
  taskIndex: string;
  taskLimit?: number;
  runtime: string;
  timeoutSeconds: number;
  solveTimeoutSeconds: number;
  solveCommand?: string;
  solveCommandFile?: string;
  forwardEnv: string[];
  prewarmProfile?: string;
  vercelSnapshotId?: string;
  modalImageId?: string;
  daytonaSnapshot?: string;
  awsMicrovmImageId?: string;
  awsMicrovmImageVersion?: string;
  awsMicrovmExecutionRoleArn?: string;
  concurrency: number;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  output?: string;
};
