set -eu

cat > /tmp/openrouter_solver.py <<'PY'
import json
import os
import pathlib
import re
import subprocess
import sys
import textwrap
import urllib.error
import urllib.request

API_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = os.environ.get("OPENROUTER_MODEL", "").strip()
MAX_STEPS = int(os.environ.get("SOLVER_MAX_STEPS", "3"))
STEP_TIMEOUT = int(os.environ.get("SOLVER_STEP_TIMEOUT_SECONDS", "240"))
MAX_TOKENS = int(os.environ.get("SOLVER_MAX_TOKENS", "6000"))


def read_text(path, limit=20000):
    try:
        text = pathlib.Path(path).read_text(errors="replace")
    except FileNotFoundError:
        return f"{path} not found"
    if len(text) > limit:
        return text[:limit] + "\n...[truncated]..."
    return text


def run(command, timeout):
    process = subprocess.run(
        ["/bin/bash", "-lc", command],
        cwd="/workspace",
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    return process.returncode, process.stdout[-12000:], process.stderr[-12000:]


def workspace_context():
    rc, stdout, stderr = run(
        "find /workspace -maxdepth 4 -type f "
        "-not -path '*/.git/*' -not -path '*/node_modules/*' "
        "-printf '%p\\n' | sort | head -200",
        30,
    )
    paths = [line.strip() for line in stdout.splitlines() if line.strip()]
    chunks = [f"Workspace files:\n{stdout or stderr}"]
    total = sum(len(chunk) for chunk in chunks)
    for path in paths:
        if total > 70000:
            break
        try:
            file_path = pathlib.Path(path)
            if file_path.stat().st_size > 60000:
                continue
            data = file_path.read_bytes()
            if b"\x00" in data[:4096]:
                continue
            text = data.decode("utf-8", errors="replace")
        except OSError:
            continue
        snippet = f"\n--- {path} ---\n{text[:12000]}"
        chunks.append(snippet)
        total += len(snippet)
    return "\n".join(chunks)


def extract_script(content):
    match = re.search(r"```(?:bash|sh|shell)?\s*\n(.*?)```", content, re.DOTALL | re.IGNORECASE)
    script = match.group(1) if match else content
    prelude = """
if [ "$(id -u)" -eq 0 ] || ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
  sudo() {
    command "$@"
  }
fi
export DEBIAN_FRONTEND=noninteractive
if ! command -v apt-get >/dev/null 2>&1 && command -v dnf >/dev/null 2>&1; then
  apt-get() {
    if [ "${1:-}" = "update" ]; then
      return 0
    fi
    if [ "${1:-}" = "install" ]; then
      shift
      packages=()
      for package in "$@"; do
        case "$package" in
          -*) ;;
          build-essential) packages+=(gcc gcc-c++ make) ;;
          default-jdk) packages+=(java-21-amazon-corretto-devel) ;;
          gfortran) packages+=(gcc-gfortran) ;;
          libcurl4-openssl-dev) packages+=(libcurl-devel) ;;
          libssl-dev) packages+=(openssl-devel) ;;
          libxml2-dev) packages+=(libxml2-devel) ;;
          pkg-config) packages+=(pkgconf-pkg-config) ;;
          r-base|r-base-dev) packages+=(R R-devel) ;;
          *) packages+=("$package") ;;
        esac
      done
      if [ "${#packages[@]}" -eq 0 ]; then
        return 0
      fi
      dnf install -y "${packages[@]}"
      return $?
    fi
    dnf "$@"
  }
fi
"""
    return prelude + "\n" + script.strip() + "\n"


def chat(messages):
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        print("OPENROUTER_API_KEY is not set", file=sys.stderr)
        sys.exit(2)
    body = {
        "messages": messages,
        "temperature": float(os.environ.get("SOLVER_TEMPERATURE", "0.2")),
        "max_tokens": MAX_TOKENS,
    }
    if MODEL:
        body["model"] = MODEL
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/openai/code-sandbox-bench",
            "X-Title": "code-sandbox-bench",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenRouter HTTP {exc.code}: {details}") from exc
    return payload["choices"][0]["message"]["content"]


task = read_text("/workspace/TASK.md", 40000)
tests = read_text("/tests/test_outputs.py", 40000)
context = workspace_context()

messages = [
    {
        "role": "system",
        "content": textwrap.dedent(
            """
            You are an autonomous TerminalBench task solver running inside a Linux sandbox.
            Work only in /workspace unless the task or tests require another path.
            You may install packages, edit files, build code, and create outputs.
            The base image may only include Python. If the task needs R, Java, build tools,
            autotools, or another runtime, install it noninteractively before using it.
            Return only a bash script to execute. Do not include explanation outside the script.
            The script should be idempotent and should not modify /tests.
            """
        ).strip(),
    },
    {
        "role": "user",
        "content": (
            f"Task:\n{task}\n\n"
            f"Verifier tests:\n{tests}\n\n"
            f"Initial workspace context:\n{context}\n\n"
            "Write a bash script that completes the task. The verifier is bash /tests/test.sh when present, otherwise pytest /tests/test_outputs.py."
        ),
    },
]

last_verify = ""
for step in range(1, MAX_STEPS + 1):
    print(f"openrouter solver step {step}/{MAX_STEPS}", flush=True)
    content = chat(messages)
    script = extract_script(content)
    script_path = pathlib.Path(f"/tmp/openrouter_solver_step_{step}.sh")
    script_path.write_text(script)
    script_path.chmod(0o755)
    print(f"--- solver script {step} ---", flush=True)
    print(script[-12000:], flush=True)
    print(f"--- end solver script {step} ---", flush=True)
    print(f"executing {script_path}", flush=True)
    rc, stdout, stderr = run(str(script_path), STEP_TIMEOUT)
    print(f"script rc={rc}", flush=True)
    if stdout:
        print(stdout[-4000:], flush=True)
    if stderr:
        print(stderr[-4000:], file=sys.stderr, flush=True)

    verify_rc, verify_stdout, verify_stderr = run(
        "if [ -f /tests/test.sh ]; then bash /tests/test.sh; else PATH=\"$HOME/.local/bin:$PATH\" pytest /tests/test_outputs.py -q; fi",
        STEP_TIMEOUT,
    )
    print(f"verify rc={verify_rc}", flush=True)
    if verify_stdout:
        print(verify_stdout[-4000:], flush=True)
    if verify_stderr:
        print(verify_stderr[-4000:], file=sys.stderr, flush=True)
    if verify_rc == 0:
        sys.exit(0)

    last_verify = f"script rc={rc}\nstdout:\n{stdout}\nstderr:\n{stderr}\nverify rc={verify_rc}\nverify stdout:\n{verify_stdout}\nverify stderr:\n{verify_stderr}"
    messages.append({"role": "assistant", "content": content})
    messages.append(
        {
            "role": "user",
            "content": (
                "The previous script did not pass. Use this feedback and return only a new bash script.\n\n"
                + last_verify[-20000:]
            ),
        }
    )

sys.exit(1)
PY

python3 /tmp/openrouter_solver.py
