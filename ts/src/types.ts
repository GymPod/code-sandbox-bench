export type BenchTask = {
  task_id: string;
  prompt: string;
  instruction: string;
  task_files: {
    encoding: string;
    content: string;
  };
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  returnCode: number;
};

export type ProviderName = "local" | "vercel" | "modal" | "daytona";

export type BenchArgs = {
  provider: ProviderName;
  dataset: string;
  taskIndex: string;
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
  concurrency: number;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  output?: string;
};
