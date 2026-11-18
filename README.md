# omp-sandbox

An [omp](https://github.com/can1357/oh-my-pi) add-on that runs an agent's tools in a remote sandbox while the agent itself stays on your machine.

It re-registers omp's built-in `bash`, `read`, `write`, `edit`, `grep` and `glob` tools under the same names, and forwards each call to a **backend**: the place where commands run and files live. The agent's session, pane, messages and model calls stay local. Its checkout, builds and tests run in the sandbox.

> **Status: prototype, private.** Step 1 of the plan below: the backend interface and a local stand-in backend. The tool replacements come in step 2. Do not install this for a live agent yet.

## Why
Design: gitmoot/gitmoot#2678, option (c). omp's built-in tools run inside the omp process, through the embedded bash engine and in-process file tools. A `shellPath` wrapper cannot move them, so the tools themselves are replaced.

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
  - **Containment `"full"`** runs each command in its own pid namespace (`unshare --pid --fork --kill-child`). It is picked when `unshare` works: as root, or as a user allowed to create user namespaces.
  - **Otherwise `"process-tree"`:** the kill freezes the descendant tree with `SIGSTOP` round by round, then kills it. The command is not PID 1, so `$$` is 2 and signals behave normally.

### Planned
- `gitmoot workspace` (the first real backend), built against the CLI agreed on #2678.
- ssh and docker, later.

## Development
```sh
bun install
bun test          # unit tests (Linux; they use /proc)
bunx tsc --noEmit # typecheck
```

## Plan
One PR per step, each independently reviewed at its exact head before merge.

1. Backend interface plus `LocalBackend`. *(this PR)*
2. Replacements for `bash`, `read`, `write`, `edit`, `grep` and `glob`, under the built-in names, with a host-to-sandbox path map. Paths outside the workspace are refused, and the add-on refuses to run with `lsp` or `eval` enabled.
3. A prototype in a throwaway omp agent dir, driven by a scripted provider (no model tokens). It answers whether background jobs, approvals and the output minimizer still work with replaced tools, how `lsp`/`eval` are turned off, what other paths to host execution remain, and how fast the file tools are at repo size.
4. The `gitmoot workspace` backend.
5. ssh and docker backends. The repo goes public after the prototype passes and an independent review.

## Safety
**Never install this into `~/.omp/agent/extensions`.** Every omp session for that user loads that directory. Load it explicitly instead, with `omp --extension <path>` or `--trusted-extension <abs-path>`.
