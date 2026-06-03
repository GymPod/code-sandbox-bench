import { readFileSync } from "node:fs";
import type { BenchTask } from "./types";

export function loadTasks(path: string, taskIndex: string, taskLimit?: number): BenchTask[] {
  const tasks = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BenchTask);
  if (taskIndex === "all") {
    return taskLimit === undefined ? tasks : tasks.slice(0, taskLimit);
  }
  const selected = [tasks[Number.parseInt(taskIndex, 10)]];
  return taskLimit === undefined ? selected : selected.slice(0, taskLimit);
}
