import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

// Triage failed tasks from bench result files into the categories used by
// reports/failure-modes-tradeoffs.md, so a 100-task run can be split into
// provider fidelity gaps vs solver/patch failures vs real task failures.
//
//   bun src/triage.ts results/ts-vercel-cold-solve-all-*.json [more.json ...] [--output triage.md]

type TaskResult = {
  task_id: string;
  task_repo?: string;
  passed: boolean;
  return_code: number;
  elapsed_seconds?: number;
  stdout_tail?: string;
  stderr_tail?: string;
  solve_return_code?: number;
  solve_stdout_tail?: string;
  solve_stderr_tail?: string;
  task_attempts?: number;
};

type BenchSummary = {
  provider: string;
  mode: string;
  kind: string;
  passed: number;
  task_count: number;
  results: TaskResult[];
};

type Category =
  | "provider_transport"
  | "environment_fidelity"
  | "patch_application"
  | "timeout"
  | "real_test_failure"
  | "unknown";

type Finding = {
  run: string;
  provider: string;
  mode: string;
  task_id: string;
  task_repo?: string;
  category: Category;
  evidence: string;
};

const TRANSPORT_PATTERNS = [
  /StreamError: Stream ended before command finished/,
  /Unable to connect\. Is the computer able to access the url\?/,
  /AbortError: The operation was aborted/,
  /Status code 410 is not ok/,
  /Deadline exceeded/,
  /Failed to read exec stdio stream/,
  /UNAVAILABLE/,
  /Name resolution failed/,
  /ECONNREFUSED/,
  /No connection established/,
  /RESOURCE_EXHAUSTED/,
  /502 Bad Gateway/
];

const ENVIRONMENT_PATTERNS = [
  /ModuleNotFoundError/,
  /ImportError/,
  /No module named/,
  /command not found/,
  /_sqlite3/,
  /error: collection failure/i,
  /errors during collection/i,
  /ERROR collecting/,
  /bench-install-cmd-failed/,
  /No matching distribution found/,
  /Could not find a version that satisfies/,
  /fatal: unable to access/,
  /OSError: \[Errno 28\]/,
  /No space left on device/,
  /Killed/
];

const PATCH_PATTERNS = [/Unreversed patch detected/, /hunks? FAILED/i, /saving rejects to/i, /\.rej\b/, /can't find file to patch/i];

const REAL_FAILURE_PATTERN = /=+ .*\b\d+ failed\b.* =+|\bFAILED\b.*::|All the tests did not pass/;

function classify(result: TaskResult): { category: Category; evidence: string } {
  const haystacks: Array<[string, string]> = [
    ["stderr", result.stderr_tail ?? ""],
    ["stdout", result.stdout_tail ?? ""],
    ["solve_stderr", result.solve_stderr_tail ?? ""],
    ["solve_stdout", result.solve_stdout_tail ?? ""]
  ];
  const match = (patterns: RegExp[]): string | undefined => {
    for (const [name, text] of haystacks) {
      for (const pattern of patterns) {
        const found = text.match(pattern);
        if (found) {
          return `${name}: ${found[0]}`;
        }
      }
    }
    return undefined;
  };
  if (result.return_code === 124 || match([/timed out after/]) !== undefined) {
    return { category: "timeout", evidence: match([/timed out after/]) ?? `return_code=${result.return_code}` };
  }
  const transport = match(TRANSPORT_PATTERNS);
  if (transport) {
    return { category: "provider_transport", evidence: transport };
  }
  const patch = match(PATCH_PATTERNS);
  if (patch) {
    return { category: "patch_application", evidence: patch };
  }
  const environment = match(ENVIRONMENT_PATTERNS);
  if (environment) {
    return { category: "environment_fidelity", evidence: environment };
  }
  const real = match([REAL_FAILURE_PATTERN]);
  if (real) {
    return { category: "real_test_failure", evidence: real };
  }
  return { category: "unknown", evidence: (result.stderr_tail || result.stdout_tail || "").slice(-200) };
}

function main(): void {
  const argv = Bun.argv.slice(2);
  const files: string[] = [];
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") {
      output = argv[index + 1];
      index += 1;
    } else {
      files.push(argv[index]);
    }
  }
  if (files.length === 0) {
    console.error("usage: bun src/triage.ts <bench-result.json> [...] [--output triage.md]");
    process.exit(2);
  }

  const findings: Finding[] = [];
  const runLines: string[] = [];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<BenchSummary>;
    const summary: BenchSummary = {
      provider: parsed.provider ?? "?",
      mode: parsed.mode ?? "?",
      kind: parsed.kind ?? "?",
      passed: parsed.passed ?? 0,
      task_count: parsed.task_count ?? 0,
      results: parsed.results ?? []
    };
    const run = basename(file);
    runLines.push(`- \`${run}\`: ${summary.provider} ${summary.mode} ${summary.kind}, ${summary.passed}/${summary.task_count} passed`);
    for (const result of summary.results) {
      if (result.passed) {
        continue;
      }
      const { category, evidence } = classify(result);
      findings.push({
        run,
        provider: summary.provider,
        mode: summary.mode,
        task_id: result.task_id,
        task_repo: result.task_repo,
        category,
        evidence: evidence.replaceAll("\n", " ").slice(0, 160)
      });
    }
  }

  const counts = new Map<string, number>();
  for (const finding of findings) {
    const key = `${finding.provider}-${finding.mode}/${finding.category}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const lines: string[] = [
    "# Failure Triage",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Runs",
    "",
    ...runLines,
    "",
    "## Category Counts",
    "",
    "run | category | failures",
    "--- | --- | ---",
    ...[...counts.entries()].sort().map(([key, count]) => {
      const [run, category] = key.split("/");
      return `${run} | ${category} | ${count}`;
    }),
    "",
    "## Failed Tasks",
    "",
    "task | repo | provider | mode | category | evidence",
    "--- | --- | --- | --- | --- | ---",
    ...findings.map(
      (finding) =>
        `\`${finding.task_id}\` | ${finding.task_repo ?? "?"} | ${finding.provider} | ${finding.mode} | ${finding.category} | ${finding.evidence.replaceAll("|", "\\|")}`
    ),
    ""
  ];
  const text = lines.join("\n");
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, text);
  }
  console.log(text);
}

main();
