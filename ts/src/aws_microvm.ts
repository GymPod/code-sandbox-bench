import { randomUUID } from "node:crypto";
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand
} from "@aws-sdk/client-lambda-microvms";
import type { CommandResult } from "./types";

export type AwsMicrovmIdlePolicy = {
  maxIdleDurationSeconds: number;
  suspendedDurationSeconds: number;
  autoResumeEnabled: boolean;
};

export type AwsMicrovmSandboxConfig = {
  region: string;
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  port: number;
  authTokenExpirationMinutes: number;
  maximumDurationInSeconds: number;
  idlePolicy: AwsMicrovmIdlePolicy;
  ingressNetworkConnectors: string[];
  egressNetworkConnectors: string[];
  logGroup?: string;
  clientTokenPrefix: string;
  startTimeoutSeconds: number;
  quotaRetryDelaySeconds: number;
};

export type AwsMicrovmSandboxEnvOptions = {
  imageIdentifier?: string;
  imageVersion?: string;
  executionRoleArn?: string;
  timeoutSeconds: number;
};

export class AwsMicrovmSandbox {
  private readonly client: LambdaMicrovmsClient;
  private microvmId: string | undefined;
  private endpoint: string | undefined;
  private authToken: string | undefined;
  private authTokenExpiresAt = 0;

  constructor(private readonly config: AwsMicrovmSandboxConfig) {
    this.client = new LambdaMicrovmsClient({ region: config.region });
  }

  async start(): Promise<void> {
    const response = await this.runMicrovmWithQuotaRetry();
    this.microvmId = required(response.microvmId, "RunMicrovm did not return a microvmId");
    this.endpoint = required(response.endpoint, "RunMicrovm did not return an endpoint");
    await this.waitForReady();
  }

  async run(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult> {
    if (!this.microvmId || !this.endpoint) {
      throw new Error("AWS MicroVM sandbox not started");
    }
    return await this.postCommand(command, cwd, timeoutSeconds);
  }

  async stop(): Promise<void> {
    if (!this.microvmId) {
      return;
    }
    const microvmIdentifier = this.microvmId;
    this.microvmId = undefined;
    this.endpoint = undefined;
    this.authToken = undefined;
    try {
      await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier }));
    } catch (error) {
      if (!isResourceNotFound(error)) {
        throw error;
      }
    }
  }

  private async runMicrovmWithQuotaRetry(): Promise<{
    microvmId?: string;
    endpoint?: string;
  }> {
    const started = performance.now();
    let lastError: unknown;
    while ((performance.now() - started) / 1000 < this.config.startTimeoutSeconds) {
      try {
        return await this.client.send(
          new RunMicrovmCommand({
            imageIdentifier: this.config.imageIdentifier,
            imageVersion: this.config.imageVersion,
            executionRoleArn: this.config.executionRoleArn,
            maximumDurationInSeconds: this.config.maximumDurationInSeconds,
            idlePolicy: this.config.idlePolicy,
            ingressNetworkConnectors: this.config.ingressNetworkConnectors,
            egressNetworkConnectors: this.config.egressNetworkConnectors,
            logging: this.config.logGroup ? { cloudWatch: { logGroup: this.config.logGroup } } : undefined,
            clientToken: `${this.config.clientTokenPrefix}-${randomUUID()}`
          })
        );
      } catch (error) {
        lastError = error;
        if (!isQuotaExceeded(error)) {
          throw error;
        }
        await sleep(this.config.quotaRetryDelaySeconds * 1000);
      }
    }
    throw new Error(`AWS MicroVM start timed out waiting for quota: ${formatError(lastError)}`);
  }

  private async waitForReady(): Promise<void> {
    const started = performance.now();
    const timeoutMs = Math.min(120_000, Math.max(30_000, this.config.maximumDurationInSeconds * 1000));
    let lastError: unknown;
    while (performance.now() - started < timeoutMs) {
      try {
        await this.refreshEndpoint();
        await this.authedFetch("/health", {
          method: "GET",
          signal: AbortSignal.timeout(10_000)
        });
        return;
      } catch (error) {
        lastError = error;
        await sleep(2000);
      }
    }
    throw new Error(`AWS MicroVM did not become ready: ${formatError(lastError)}`);
  }

  private async refreshEndpoint(): Promise<void> {
    if (!this.microvmId) {
      return;
    }
    const response = await this.client.send(new GetMicrovmCommand({ microvmIdentifier: this.microvmId }));
    if (response.endpoint) {
      this.endpoint = response.endpoint;
    }
  }

  private async postCommand(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult> {
    const started = performance.now();
    const startResponse = await this.authedFetch("/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, cwd, timeoutSeconds }),
      signal: AbortSignal.timeout(15_000)
    });
    const startedJob = (await startResponse.json()) as { jobId?: string; error?: string };
    if (!startedJob.jobId) {
      throw new Error(startedJob.error ?? "AWS MicroVM command did not return a jobId");
    }
    let lastPollError: unknown;
    while ((performance.now() - started) / 1000 < timeoutSeconds + 30) {
      try {
        const response = await this.authedFetch(`/commands/${encodeURIComponent(startedJob.jobId)}`, {
          method: "GET",
          signal: AbortSignal.timeout(15_000)
        });
        lastPollError = undefined;
        const parsed = (await response.json()) as Partial<CommandResult> & { status?: string; error?: string };
        if (parsed.status === "completed") {
          return {
            stdout: String(parsed.stdout ?? ""),
            stderr: String(parsed.stderr ?? ""),
            returnCode: Number(parsed.returnCode ?? 1)
          };
        }
        if (parsed.error) {
          return { stdout: "", stderr: parsed.error, returnCode: 1 };
        }
      } catch (error) {
        lastPollError = error;
        if (!isRetryablePollError(error)) {
          throw error;
        }
        await this.refreshEndpoint().catch(() => undefined);
        this.authToken = undefined;
      }
      await sleep(2000);
    }
    return {
      stdout: "",
      stderr: `Command timed out after ${timeoutSeconds}s${lastPollError ? `; last poll error: ${formatError(lastPollError)}` : ""}`,
      returnCode: 124
    };
  }

  private async authedFetch(path: string, init: RequestInit): Promise<Response> {
    const token = await this.getAuthToken();
    const response = await fetch(this.url(path), {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        "X-aws-proxy-auth": token,
        "X-aws-proxy-port": String(this.config.port)
      }
    });
    if (!response.ok) {
      throw new AwsMicrovmHttpError(response.status, await response.text());
    }
    return response;
  }

  private async getAuthToken(): Promise<string> {
    if (this.authToken && Date.now() < this.authTokenExpiresAt - 60_000) {
      return this.authToken;
    }
    if (!this.microvmId) {
      throw new Error("AWS MicroVM sandbox not started");
    }
    const response = await this.client.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: this.microvmId,
        expirationInMinutes: this.config.authTokenExpirationMinutes,
        allowedPorts: [{ port: this.config.port }]
      })
    );
    const token = response.authToken?.["X-aws-proxy-auth"];
    if (!token) {
      throw new Error("CreateMicrovmAuthToken did not return X-aws-proxy-auth");
    }
    this.authToken = token;
    this.authTokenExpiresAt = Date.now() + this.config.authTokenExpirationMinutes * 60_000;
    return token;
  }

  private url(path: string): string {
    if (!this.endpoint) {
      throw new Error("AWS MicroVM endpoint is unavailable");
    }
    const base = this.endpoint.startsWith("http") ? this.endpoint : `https://${this.endpoint}`;
    return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
  }
}

export function awsMicrovmConfigFromEnv(options: AwsMicrovmSandboxEnvOptions): AwsMicrovmSandboxConfig {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const imageIdentifier = options.imageIdentifier ?? process.env.AWS_MICROVM_IMAGE_ID ?? process.env.AWS_MICROVM_IMAGE_ARN;
  if (!imageIdentifier) {
    throw new Error("AWS MicroVM provider requires AWS_MICROVM_IMAGE_ID or --aws-microvm-image-id");
  }
  const maximumDurationInSeconds = envInt(
    "AWS_MICROVM_MAX_DURATION_SECONDS",
    Math.max(180, Math.min(3600, options.timeoutSeconds + 180))
  );
  const port = envInt("AWS_MICROVM_PORT", 8080);
  return {
    region,
    imageIdentifier,
    imageVersion: options.imageVersion ?? process.env.AWS_MICROVM_IMAGE_VERSION,
    executionRoleArn: options.executionRoleArn ?? process.env.AWS_MICROVM_EXECUTION_ROLE_ARN,
    port,
    authTokenExpirationMinutes: envInt("AWS_MICROVM_AUTH_TOKEN_MINUTES", 30),
    maximumDurationInSeconds,
    startTimeoutSeconds: envInt("AWS_MICROVM_START_TIMEOUT_SECONDS", 600),
    quotaRetryDelaySeconds: envInt("AWS_MICROVM_QUOTA_RETRY_SECONDS", 15),
    idlePolicy: {
      maxIdleDurationSeconds: envInt("AWS_MICROVM_MAX_IDLE_DURATION_SECONDS", 120),
      suspendedDurationSeconds: envInt("AWS_MICROVM_SUSPENDED_DURATION_SECONDS", 0),
      autoResumeEnabled: envBool("AWS_MICROVM_AUTO_RESUME", false)
    },
    ingressNetworkConnectors: envList("AWS_MICROVM_INGRESS_CONNECTORS", [
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`
    ]),
    egressNetworkConnectors: envList("AWS_MICROVM_EGRESS_CONNECTORS", [
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`
    ]),
    logGroup: process.env.AWS_MICROVM_LOG_GROUP,
    clientTokenPrefix: process.env.AWS_MICROVM_CLIENT_TOKEN_PREFIX ?? "code-sandbox-bench"
  };
}

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function envList(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function required(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function isResourceNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === "ResourceNotFoundException";
}

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof Error && error.name === "ServiceQuotaExceededException";
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class AwsMicrovmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`AWS MicroVM request failed with ${status}: ${body}`);
    this.name = "AwsMicrovmHttpError";
  }
}

function isRetryablePollError(error: unknown): boolean {
  if (error instanceof AwsMicrovmHttpError) {
    return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error) {
    return /AbortError|TimeoutError|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(`${error.name}: ${error.message}`);
  }
  return false;
}
