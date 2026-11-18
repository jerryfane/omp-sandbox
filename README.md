# omp-sandbox

An [omp](https://github.com/can1357/oh-my-pi) add-on that runs an agent's tools in a remote sandbox while the agent itself stays on your machine.

It re-registers omp's built-in `bash`, `read`, `write`, `edit`, `grep` and `glob` tools under the same names, and forwards each call to a **backend**: the place where commands run and files live. The agent's session, pane, messages and model calls stay local. Its checkout, builds and tests run in the sandbox.

> **Status: prototype, private.** Steps 1 and 2a of the plan below: the backend interface, a local stand-in backend, and the `bash` replacement. The file tools still act on host files until step 2b. Do not install this for a live agent yet.

## Why
Design: gitmoot/gitmoot#2678, option (c). omp's built-in tools run inside the omp process, through the embedded bash engine and in-process file tools. A `shellPath` wrapper cannot move them, so the tools themselves are replaced.

## How `bash` moves into the sandbox
[`src/extension.ts`](src/extension.ts) registers a tool named `bash`, which shadows the built-in. A call is not executed by the add-on:
1. The command is rewritten into the backend's host command line, `Backend.shellCommand`. With `LocalBackend` that is `/usr/bin/env -i -C <sandbox cwd> <sandbox env> /bin/bash -c <command>`, inside `unshare` in full containment.
2. The rewritten call is handed back to **omp's own bash** through `ctx.invokeTool`.

So omp's background jobs (`async`), auto-backgrounding, timeouts, streaming and exit-code reporting keep working unchanged. The integration test drives the installed omp to show it.

- **`cwd`** is mapped from the host workspace onto the sandbox root (`PathMap`). A `cwd` outside the workspace is refused.
- **Refused:** `pty` and named services (`name`/`ready`). Both would run on this machine.
- **Approvals:** each call is judged by **omp's own bash approval rules**: `tools.approvalMode`, `tools.approval.bash`, `bash.patterns` allow/prompt/deny, the bash interceptor, and critical-command prompts. They are applied to the command the agent wrote, not the rewritten line. The delegated native call is not gated a second time. The add-on gets these rules by importing omp's `BashTool` (`@oh-my-pi/pi-coding-agent/tools/bash`), whose approval reads only settings.
- **Fail closed:** if the add-on is configured but its backend cannot be set up, or omp's bash approval rules cannot be loaded, `bash` refuses every call instead of running on the host.
- **Known gap:** omp's background-job notices show the rewritten command line. A real backend keeps it short; for gitmoot it is `gitmoot ws sh …`.

Configuration, in the omp process's environment:

| Variable | Meaning |
|---|---|
| `OMP_SANDBOX_BACKEND` | `local` (tests). Unset: the add-on does nothing |
| `OMP_SANDBOX_LOCAL_ROOT` | local backend: the directory that is the sandbox |
| `OMP_SANDBOX_LOCAL_CONTAINMENT` | local backend: `full` or `process-tree` (default: the best available) |
| `OMP_SANDBOX_HOST_ROOT` | the host workspace mapped onto the sandbox root (default: omp's cwd) |

## Backends
A backend implements `Backend` in [`src/backend.ts`](src/backend.ts):

| Method | Does |
|---|---|
| `exec(command, {cwd, env, timeoutMs, signal, onOutput, maxOutputBytes})` | runs `bash -c <command>` in the sandbox: streams output, starts from the backend's own minimal environment (never the host's), and on timeout or abort kills every process the command started, including ones that called `setsid` |
| `readFile(path)` / `writeFile(path, data, {mode})` | whole-file read and write of regular files; write creates parent directories and keeps an existing file's mode unless `mode` is given |
| `stat(path)` | type, size and mtime without following a final symlink; `null` if missing |
| `list(path, {recursive, limit})` | listing sorted by full path in byte order (C collation), so `limit` keeps the sorted prefix; symlinked directories are listed, never entered |
| `containment` | `"full"`: every descendant is killed on timeout or abort, and leftovers are killed when the command's shell exits. `"process-tree"`: every descendant still linked to the command is killed, but a process whose parent already exited, and anything left running after the shell exits, survives |

Every path a backend takes is an absolute path *inside the sandbox*. Translating the agent's host paths to sandbox paths is the tool layer's job. No backend method may ever touch anything outside the sandbox, whatever symlinks or concurrent renames it contains.

### `LocalBackend` (tests only)
[`src/local-backend.ts`](src/local-backend.ts) treats a directory on this host as the sandbox. Linux only.
- **File operations are confined to that directory.**
  - Every path is resolved one component at a time from an open descriptor of the root, with `O_NOFOLLOW`, through `/proc/self/fd/<n>/<name>`.
  - No symlink is ever followed, even one that stays inside: such a path fails with `SYMLINK`.
  - A concurrent rename cannot redirect an operation, because each step uses the directory already opened, not a name looked up again.
  - Tests use this to prove a tool never touches a host file.
- **`exec` is a host subprocess and is not confined.** It exists to exercise the tools without a VM.
  - **Containment `"full"`** runs each command in its own user and pid namespace (`unshare --user --map-root-user --pid --fork --kill-child`), under a small Python init.
    - The user namespace is always used, also when running as root, so the namespace never holds real root. As root, its uid 0 still maps to the real uid 0: root-owned files stay accessible, but capabilities are confined to the new namespaces.
    - No mount namespace and no `/proc` remount.
    - The command itself is not PID 1, so `$$` is 2 and signals behave normally.
    - A command that dies of a signal is reported as that signal, not as exit 128+n. The init writes it to a private per-command file and adds nothing to the command's output.
    - It needs `unshare` and `python3`, and is picked when both work: as root, or as a user allowed to create user namespaces.
  - **Otherwise `"process-tree"`:** the kill freezes the descendant tree with `SIGSTOP` round by round, then kills it.
- **Errors:** a directory a recursive `list` cannot open fails the whole call with `EACCES` (or its own code), so a listing is never silently incomplete.

### Planned
- `gitmoot workspace` (the first real backend), built against the CLI agreed on #2678.
- ssh and docker, later.

## Development
```sh
bun install
bun test          # unit tests (Linux; they use /proc) and, when omp is installed,
                  # an integration test that runs it with a scripted provider (no model, no spend)
bunx tsc --noEmit # typecheck
```

## Plan
One PR per step, each independently reviewed at its exact head before merge.

1. Backend interface plus `LocalBackend`. *(done, #1 and #2)*
2. **2a:** the `bash` replacement. *(this PR)*
   **2b:** `read`, `write`, `edit`, `grep`, `glob` and `find`. They run on a host mirror of the sandbox work tree that is kept in sync with the sandbox, so omp's own tools and their line tags keep working. The add-on refuses to run with `lsp` or `eval` enabled.
3. A prototype in a throwaway omp agent dir, driven by a scripted provider (no model tokens). It answers whether background jobs, approvals and the output minimizer still work with replaced tools, how `lsp`/`eval` are turned off, what other paths to host execution remain, and how fast the file tools are at repo size.
4. The `gitmoot workspace` backend.
5. ssh and docker backends. The repo goes public after the prototype passes and an independent review.

## Safety
**Never install this into `~/.omp/agent/extensions`.** Every omp session for that user loads that directory. Load it explicitly instead, with `omp --extension <path>` or `--trusted-extension <abs-path>`.
