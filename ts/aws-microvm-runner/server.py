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
LIFECYCLE_PREFIX = "/aws/lambda-microvms/runtime/v1/"
JOBS = {}
JOBS_LOCK = threading.Lock()


def json_bytes(payload):
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


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
            return dict(job)

    def run_job(self, job_id, command, cwd, timeout):
        result = self.run_shell(command, cwd, timeout)
        with JOBS_LOCK:
            if job_id in JOBS:
                JOBS[job_id].update(
                    {
                        "status": "completed",
                        "completedAt": time.time(),
                        "stdout": result["stdout"],
                        "stderr": result["stderr"],
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

    def run_shell(self, command, cwd, timeout):
        try:
            completed = subprocess.run(
                ["/bin/sh", "-lc", command],
                cwd=cwd or "/",
                text=True,
                capture_output=True,
                timeout=timeout,
                env=os.environ.copy(),
            )
            return {
                "stdout": completed.stdout,
                "stderr": completed.stderr,
                "returnCode": completed.returncode,
            }
        except subprocess.TimeoutExpired as exc:
            stdout = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout or b"").decode("utf-8", "replace")
            stderr = exc.stderr if isinstance(exc.stderr, str) else (exc.stderr or b"").decode("utf-8", "replace")
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
    for path in ("/workspace", "/testbed", "/tests", "/solution", "/logs", "/tmp/tb"):
        Path(path).mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), RunnerHandler)
    print(f"code-sandbox-bench MicroVM runner listening on {PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
