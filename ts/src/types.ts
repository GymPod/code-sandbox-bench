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

export type ProviderName = "local" | "vercel";

export type BenchArgs = {
  provider: ProviderName;
  dataset: string;
  taskIndex: string;
  runtime: string;
  timeoutSeconds: number;
  concurrency: number;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  output?: string;
};
