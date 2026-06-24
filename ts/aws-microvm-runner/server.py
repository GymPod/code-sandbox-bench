#!/usr/bin/env python3
import json
import os
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


PORT = int(os.environ.get("AWS_MICROVM_RUNNER_PORT", "8080"))
MAX_BODY_BYTES = int(os.environ.get("AWS_MICROVM_RUNNER_MAX_BODY_BYTES", str(4 * 1024 * 1024)))
MAX_OUTPUT_BYTES = int(os.environ.get("AWS_MICROVM_RUNNER_MAX_OUTPUT_BYTES", str(2 * 1024 * 1024)))
LIFECYCLE_PREFIX = "/aws/lambda-microvms/runtime/v1/"
JOB_DIR = Path(os.environ.get("AWS_MICROVM_RUNNER_JOB_DIR", "/tmp/code-sandbox-bench-jobs"))
JOBS = {}
JOBS_LOCK = threading.Lock()


def json_bytes(payload):
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def read_output(raw_path):
    if not raw_path:
        return ""
    path = Path(str(raw_path))
    if not path.exists():
        return ""
    with path.open("rb") as stream:
        size = path.stat().st_size
        if size > MAX_OUTPUT_BYTES:
            stream.seek(-MAX_OUTPUT_BYTES, os.SEEK_END)
        return stream.read().decode("utf-8", "replace")


class RunnerHandler(BaseHTTPRequestHandler):
    server_version = "code-sandbox-bench-aws-microvm/0.1"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def do_GET(self):
        if self.path == "/health":
            self.respond_json({"ok": True})
            return
        if self.path.startswith("/commands/"):
            self.respond_json(self.get_job(self.path.removeprefix("/commands/")))
            return
        self.respond_json({"error": "not found"}, status=404)

    def do_POST(self):
        if self.path.startswith(LIFECYCLE_PREFIX):
            self.respond_json({"ok": True, "hook": self.path.removeprefix(LIFECYCLE_PREFIX)})
            return
        if self.path == "/commands":
            try:
                payload = self.read_json()
                command = payload.get("command")
                if not isinstance(command, str) or not command:
                    raise ValueError("command must be a non-empty string")
                cwd = payload.get("cwd")
                timeout = int(payload.get("timeoutSeconds") or 180)
                job_id = self.start_job(command, cwd, timeout)
                self.respond_json({"jobId": job_id})
            except Exception as exc:
                self.respond_json({"error": f"{type(exc).__name__}: {exc}"}, status=400)
            return
        if self.path != "/run-command":
            self.respond_json({"error": "not found"}, status=404)
            return
        try:
            payload = self.read_json()
            command = payload.get("command")
            if not isinstance(command, str) or not command:
                raise ValueError("command must be a non-empty string")
            cwd = payload.get("cwd")
            timeout = int(payload.get("timeoutSeconds") or 180)
            if cwd is not None:
                if not isinstance(cwd, str) or not cwd.startswith("/"):
                    raise ValueError("cwd must be an absolute path when provided")
                Path(cwd).mkdir(parents=True, exist_ok=True)
            result = self.run_shell(command, cwd, timeout)
            self.respond_json(result)
        except Exception as exc:
            self.respond_json({"stdout": "", "stderr": f"{type(exc).__name__}: {exc}", "returnCode": 1})

    def start_job(self, command, cwd, timeout):
        if cwd is not None:
            if not isinstance(cwd, str) or not cwd.startswith("/"):
                raise ValueError("cwd must be an absolute path when provided")
            Path(cwd).mkdir(parents=True, exist_ok=True)
        job_id = uuid.uuid4().hex
        with JOBS_LOCK:
            JOBS[job_id] = {
                "jobId": job_id,
                "status": "running",
                "startedAt": time.time(),
                "stdoutPath": str(JOB_DIR / f"{job_id}.stdout"),
                "stderrPath": str(JOB_DIR / f"{job_id}.stderr"),
                "stdout": "",
                "stderr": "",
                "returnCode": None,
            }
        thread = threading.Thread(target=self.run_job, args=(job_id, command, cwd, timeout), daemon=True)
        thread.start()
        return job_id

    def get_job(self, raw_job_id):
        job_id = unquote(raw_job_id)
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if job is None:
                return {"error": "job not found", "returnCode": 1}
            snapshot = dict(job)
        snapshot["stdout"] = read_output(snapshot.get("stdoutPath"))
        snapshot["stderr"] = read_output(snapshot.get("stderrPath"))
        snapshot.pop("stdoutPath", None)
        snapshot.pop("stderrPath", None)
        return snapshot

    def run_job(self, job_id, command, cwd, timeout):
        with JOBS_LOCK:
            job = dict(JOBS.get(job_id) or {})
        result = self.run_shell(command, cwd, timeout, job.get("stdoutPath"), job.get("stderrPath"))
        with JOBS_LOCK:
            if job_id in JOBS:
                JOBS[job_id].update(
                    {
                        "status": "completed",
                        "completedAt": time.time(),
                        "stdout": read_output(job.get("stdoutPath")),
                        "stderr": read_output(job.get("stderrPath")),
                        "returnCode": result["returnCode"],
                    }
                )

    def read_json(self):
        content_length = int(self.headers.get("content-length") or "0")
        if content_length > MAX_BODY_BYTES:
            raise ValueError(f"request body too large: {content_length} bytes")
        body = self.rfile.read(content_length)
        if not body:
            return {}
        return json.loads(body.decode("utf-8"))

    def run_shell(self, command, cwd, timeout, stdout_path=None, stderr_path=None):
        stdout_path = stdout_path or str(JOB_DIR / f"{uuid.uuid4().hex}.stdout")
        stderr_path = stderr_path or str(JOB_DIR / f"{uuid.uuid4().hex}.stderr")
        try:
            Path(stdout_path).parent.mkdir(parents=True, exist_ok=True)
            with open(stdout_path, "w", encoding="utf-8", errors="replace") as stdout_file, open(
                stderr_path, "w", encoding="utf-8", errors="replace"
            ) as stderr_file:
                completed = subprocess.run(
                    ["/bin/sh", "-lc", command],
                    cwd=cwd or "/",
                    text=True,
                    stdout=stdout_file,
                    stderr=stderr_file,
                    timeout=timeout,
                    env=os.environ.copy(),
                )
            return {
                "stdout": read_output(stdout_path),
                "stderr": read_output(stderr_path),
                "returnCode": completed.returncode,
            }
        except subprocess.TimeoutExpired as exc:
            stdout = read_output(stdout_path)
            stderr = read_output(stderr_path)
            stderr = f"{stderr}\nCommand timed out after {timeout}s".strip()
            return {"stdout": stdout, "stderr": stderr, "returnCode": 124}

    def respond_json(self, payload, status=200):
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    JOB_DIR.mkdir(parents=True, exist_ok=True)
    for path in ("/workspace", "/testbed", "/tests", "/solution", "/logs", "/tmp/tb"):
        Path(path).mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), RunnerHandler)
    print(f"code-sandbox-bench MicroVM runner listening on {PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
