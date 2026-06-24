# Provider Configuration

These docs describe how the TypeScript harness configures each remote sandbox provider.

- [Vercel](vercel.md)
- [Modal](modal.md)
- [Daytona](daytona.md)
- [AWS Lambda MicroVMs](aws-microvm.md)

The common execution path lives in `ts/src/bench.ts`:

1. Resolve the task environment with `resolveTaskEnv()`.
2. Start the provider sandbox with `makeProvider()`.
3. Upload the task archive to `/tmp/task.tar.gz.b64`.
4. Run the prepare script.
5. Write `TASK.md` into `/workspace` and, for SWE-Smith, `/testbed`.
6. Run the solver command when one is configured.
7. Run the verifier command.
8. Stop/delete the sandbox.

## Task Families

env type | workdir | environment strategy
--- | --- | ---
`terminalbench` | `/workspace` | Use the requested runtime image plus optional prewarm profile.
`harbor_swesmith` | `/testbed` | Modal and Daytona use the SWE-Smith task Docker image/Dockerfile setup; Vercel and AWS Lambda MicroVMs reconstruct the repo environment from `data/swesmith_env_manifests.json`.

## Cold vs Warm

`--mode` is recorded in result JSONs. The actual reuse behavior is provider-specific:

- Cold runs create from the requested runtime or task image with no explicit saved artifact.
- Warm TerminalBench runs may pass a provider-specific snapshot/image/profile id.
- SWE-Smith task-Docker datasets intentionally do not use generic Modal/Daytona warm artifacts in `ts/src/matrix.ts`, because each task can require a different image.
- Vercel can use a snapshot id, but SWE-Smith correctness still depends on the manifest-driven `/testbed` setup matching each repo.
- AWS Lambda MicroVMs use a prebuilt MicroVM image id for both cold and warm benchmark runs; each task still gets its own fresh MicroVM instance.
