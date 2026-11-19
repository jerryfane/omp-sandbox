# omp-sandbox

An [omp](https://github.com/can1357/oh-my-pi) add-on that runs an agent's tools in a remote sandbox while the agent itself stays on your machine.

It re-registers omp's built-in `bash` under the same name and forwards each call to a **backend**: the place where commands run and files live. omp's own file tools work on a host copy of the sandbox's files that the add-on keeps in sync. The agent's session, pane, messages and model calls stay local. Its checkout, builds and tests run in the sandbox.

> **Status: prototype.** Steps 1–4 of the plan below are done: the backend interface, a local stand-in backend, the `bash` replacement, the synced file tools, and the `gitmoot workspace` backend, checked end to end on an E2B workspace. Not yet supported: subagents (`task` is refused), and ssh or docker backends. Do not install this for a live agent yet.

## Why
Design: gitmoot/gitmoot#2678, option (c). omp's built-in tools run inside the omp process, through the embedded bash engine and in-process file tools. A `shellPath` wrapper cannot move them, so the tools themselves are replaced.

## How `bash` moves into the sandbox
[`src/extension.ts`](src/extension.ts) registers a tool named `bash`, which shadows the built-in. A call is not executed by the add-on:
1. The command is rewritten into the backend's host command line, `Backend.shellCommand`. With `LocalBackend` that is `/usr/bin/env -i -C <sandbox cwd> <sandbox env> /bin/bash -c <command>`, inside `unshare` in full containment.
2. The rewritten call is handed back to **omp's own bash** through `ctx.invokeTool`.

So omp's background jobs (`async`), auto-backgrounding, timeouts, streaming and exit-code reporting keep working unchanged. The integration test drives the installed omp to show it.

- **`cwd`** is mapped from the host copy onto the sandbox root (`PathMap`). A `cwd` outside the copy is refused.
- **Refused:** `pty` and named services (`name`/`ready`). Both would run on this machine.
- **Approvals:** each call is judged by **omp's own bash approval rules**: `tools.approvalMode`, `tools.approval.bash`, `bash.patterns` allow/prompt/deny, the bash interceptor, and critical-command prompts. They are applied to the command the agent wrote, not the rewritten line, and an interactive prompt shows that command (`formatApprovalDetails`), as native bash's does. The delegated native call is not gated a second time. The add-on gets these rules by importing omp's `BashTool` (`@oh-my-pi/pi-coding-agent/tools/bash`), whose approval reads only settings.
- **Fail closed:** if the add-on is configured but its backend cannot be set up, omp's bash approval rules or file-tool parsers cannot be loaded, or the host copy is out of sync, `bash` and the file tools refuse every call instead of acting on the host.
- **Known gap:** omp's background-job notices show the rewritten command line. A real backend keeps it short; for gitmoot it is `gitmoot ws sh …`.

## How the file tools reach the sandbox
`read`, `write`, `edit`, `grep`, `glob`, `find` and `ast_grep` run as **omp's own tools** on a **host copy** of the sandbox's workspace ([`src/mirror.ts`](src/mirror.ts)). omp's cwd is that copy. Each is re-registered as a shadow that takes its schema, description, approval, approval targets, prompt rows and documentation topics (`xd://read/…`) from an instance of omp's own tool class ([`src/file-tools.ts`](src/file-tools.ts)). That instance sees the session's current model, kept current from session events, so a model-specific contract (`edit.modelVariants`) is the same in the shadow and in the native tool it runs. The shadow runs the native tool through `ctx.invokeTool`, so `edit`'s snapshot tags and every output format are omp's. A tool omp's settings do not offer (`find` and `ast_grep` by default) is registered inactive, as it would be natively.

| When | Sync |
|---|---|
| omp starts | the copy, which must be an empty directory, is filled from the sandbox |
| a file tool runs | sandbox → copy, then the tool, then copy → sandbox |
| `bash` runs | copy → sandbox, then the command, then sandbox → copy |

- **Checked when each call runs.** A model can send several calls in one message, and omp prepares them all (its `tool_call` hooks) before running any. So the health check, the outside-path check and the syncs happen inside each shadow's own execution, not in a hook. All shadows are `exclusive`: omp runs them one at a time, so no two syncs or tool runs interleave. A `tool_call` hook also refuses early, before an approval prompt, but it is not relied on.
- **One plain path per file-tool call.** omp's file tools read some path strings as several paths (`read` splits a list on `;`, `,` and whitespace at execution; globs expand braces) or decode them (`file://`, `%`-escapes). So a path argument, or a path the tool reports, that contains `;`, `,`, a brace, a backslash, a `%`-escape or `file://` is refused with "one plain path per call"; the model makes one call per file, directory or brace alternative. Names with spaces work.
- **Paths outside the copy are refused**, judged by each tool's own parser (its `approvalCacheTargets`, the same reading of the arguments the tool will execute and that omp's approval uses), which covers `edit`'s headers and move targets, and again on every whitespace-separated piece of the raw path arguments. Internal and web URLs pass through: they are not workspace files.
- **Only files and directories are mirrored.** A symlink or special file in the sandbox is not created in the copy, and a symlink created in the copy is refused. `.git`, at any depth (a submodule's or a nested repository's too), is not mirrored in either direction, and a file-tool call on a path inside one is refused: use `git` through bash. Any other name, including the mirror's own temp-file prefix, is an ordinary file.
- **Conflicts stop the add-on; nothing is merged.**
  - Before a push, the mirror asks the sandbox what changed since the last sync. A path changed on both sides, or one inside a directory the other side changed, is a conflict and nothing is sent. So a background job's change is never overwritten by an edit made at the same time.
  - A pull never overwrites or deletes a host file that changed since the last sync.
  - A pull removes a host directory only when the mirror made it (pulling, or pushing files into it), it is still that directory (same inode), and it is empty. A directory a tool made, or a replacement of the mirror's, stays.
  - A conflict, or any other sync failure, breaks the mirror. Every later `bash` and file-tool call is refused with the reason, including calls already prepared in the same message.
- **Change detection:** the backend reports what changed since a token (`Backend.changes`), and an unknown token gets a full listing. Every reported file is pulled and compared by **content hash and mode** with the last sync. So an edit that kept the size and mtime is still found, and a file that was only touched, or the echo of a push, is no change. The host copy is compared by size, mtime, ctime, inode and mode.

## Tools refused with the sandbox
`eval`, `debug`, `lsp` and `task` are refused with a reason. Each runs code or a server on this machine with the host's filesystem and environment, and a `task` subagent's tools are not confined either. `ast_edit` is refused too: omp 18.20 reports no paths for it (no `approvalCacheTargets`), so the add-on cannot check that it stays inside the copy. Nested calls through `xd://` devices are refused the same way. At startup the add-on checks that every file tool it shadows has such a parser; if one is missing, it refuses everything.

## What still runs on this machine, and other measured limits
Probed on omp 18.20.0 with a scripted provider (no model):
- **User `!` commands** typed in omp's TUI run on this machine, as before. They come from the user, not the agent.
- **Output minimizer:** it recognizes the command inside the rewritten line, and `git status`/`git diff`/`git log` output was identical to native. A large `cat` gets the same outline as native and is then cut once more by bash's output limit, with an artifact link: less output, nothing extra.
- **Sync cost with LocalBackend** on a 1,455-file, 30 MB tree (a copy of the gitmoot repo on a local SSD): first fill 1.9 s; a pull or push with nothing changed about 0.1 s each; so about 0.2 s per tool call before any remote round trips.
- **Subagents** (`task`) are refused until their tools can be confined too.

## Configuration
In the omp process's environment:

| Variable | Meaning |
|---|---|
| `OMP_SANDBOX_BACKEND` | `gitmoot`, or `local` (tests). Unset: the add-on does nothing |
| `OMP_SANDBOX_GITMOOT_WORKSPACE` | gitmoot backend: the workspace id, from `gitmoot workspace open` |
| `OMP_SANDBOX_GITMOOT_BIN` | gitmoot backend: the gitmoot binary (default: `gitmoot` on `PATH`) |
| `OMP_SANDBOX_GITMOOT_HOME` | gitmoot backend: a gitmoot home, passed as `--home` (default: the CLI's own) |
| `OMP_SANDBOX_LOCAL_ROOT` | local backend: the directory that is the sandbox |
| `OMP_SANDBOX_LOCAL_CONTAINMENT` | local backend: `full` or `process-tree` (default: the best available) |

omp's cwd is the host copy of the workspace.

## Backends
A backend implements `Backend` in [`src/backend.ts`](src/backend.ts):

| Method | Does |
|---|---|
| `exec(command, {cwd, env, timeoutMs, signal, onOutput, maxOutputBytes})` | runs `bash -c <command>` in the sandbox: streams output, starts from the backend's own minimal environment (never the host's), and on timeout or abort kills every process the command started, including ones that called `setsid` |
| `readFile(path)` / `writeFile(path, data, {mode})` | whole-file read and write of regular files; write creates parent directories and keeps an existing file's mode unless `mode` is given |
| `stat(path)` | type, size and mtime without following a final symlink; `null` if missing |
| `list(path, {recursive, limit})` | listing sorted by full path in byte order (C collation), so `limit` keeps the sorted prefix; symlinked directories are listed, never entered |
| `changes(since?)` | what changed in the tree since a token: changed entries plus exact deletes, or the whole tree (`full`) when the token is absent or unknown; every `.git` excluded, symlinks reported, never followed |
| `pull(paths)` / `push(files)` | bulk file transfer with modes, relative paths; push is atomic per file and refuses to replace a symlink or directory |
| `remove(paths)` | unlinks files and symlinks, removes directories only when empty; a missing path is not an error |
| `containment` | `"full"`: every descendant is killed on timeout or abort, and leftovers are killed when the command's shell exits. `"process-tree"`: every descendant still linked to the command is killed, but a process whose parent already exited, and anything left running after the shell exits, survives. `"process-group"`: only the command's process group is killed; a descendant that moved to another group or session (`setsid`) survives |

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

### `GitmootBackend` ([`src/gitmoot-backend.ts`](src/gitmoot-backend.ts))
The sandbox is a gitmoot remote workspace (gitmoot/gitmoot#2678): a VM bound to one seat and one issue or PR. The add-on talks only to the `gitmoot` CLI; the CLI holds the provider credentials and enforces the pilot's cost cap. The contract is gitmoot's `skills/gitmoot/references/WORKSPACES.md`.
- **`open`** reads the workspace's root and state from `gitmoot workspace show <id> --json` and refuses a workspace that is not `ready`.
- **`shellCommand`** (for omp's bash) is `gitmoot ws sh --cwd REL '<cmd>'` by absolute path, with `GITMOOT_WORKSPACE` set. `REL` is the directory relative to the workspace root, passed exactly (gitmoot takes `--cwd` as given; `''` is the root). Extra variables are exported inside the remote shell; the VM never gets the host's environment.
- **`exec`** runs `gitmoot workspace exec <id> --cwd REL --env K=V… --status-file F -- /bin/bash -c <cmd>`. Its result comes from the status file. Timeout and abort send SIGTERM to the CLI, which forwards it to the command's whole process group (SIGKILL 3 s later); an abort or timeout during setup is never lost, and one that ends the CLI before it writes a status is reported as that cancellation. A gitmoot failure (exit 125, `error` in the status file) rejects with `GitmootCliError`.
- **Containment `"process-group"`:** gitmoot kills the command's process group, on cancellation and, if the CLI dies outright, through its VM-side watchdog within 15 s. A descendant that calls `setsid` survives both. On E2B it still dies with the VM when the workspace closes.
- **Files and sync** use gitmoot's file commands, each confined to the workspace root by gitmoot (an absolute path, a `..` or a symlink on the way is refused):

  | Method | gitmoot command |
  |---|---|
  | `readFile` / `writeFile` / `stat` | `workspace read` / `write [--mode]` / `stat --json`; exit 3 is `ENOENT`, exit 4 `EISDIR`, a symlink refusal `SYMLINK` |
  | `changes` | `workspace changes --since <token\|start> --json`; gitmoot's `reset` is `full` |
  | `pull` / `push` | `workspace pull -- <paths>` / `workspace push --files`, both a tar stream ([`src/tar.ts`](src/tar.ts): ustar with pax names; files, directories, symlinks) |
  | `remove` | `workspace remove --json -- <paths>`. gitmoot refuses the whole batch on a non-empty directory (`not_empty`); the backend then retries one path at a time, so that directory stays and the rest goes |
  | `list` | no gitmoot command: `find -printf` through `workspace exec`, in the listed directory. omp's file tools never call it; they read the host copy |
- **Tests:** `test/gitmoot-backend.test.ts` runs against a stand-in CLI that follows WORKSPACES.md, including a `Mirror` over this backend. `test/gitmoot-real.test.ts` runs against a real gitmoot build with its zero-cost `provider = "local"` in a throwaway home, including omp itself with `OMP_SANDBOX_BACKEND=gitmoot`: `GITMOOT_WS_BIN=/abs/path/to/gitmoot bun test test/gitmoot-real.test.ts`. It is skipped without that variable.

### Planned
- ssh and docker, later.

## Development
```sh
bun install
bun test          # unit tests (Linux; they use /proc) and, when omp is on PATH (or OMP_BIN names it),
                  # integration tests that run it with a scripted provider (no model, no spend)
bunx tsc --noEmit # typecheck
GITMOOT_WS_BIN=/abs/path/to/gitmoot bun test test/gitmoot-real.test.ts   # against a real gitmoot build
```

## Plan
One PR per step, each independently reviewed at its exact head before merge.

1. Backend interface plus `LocalBackend`. *(done, #1 and #2)*
2. **2a:** the `bash` replacement. *(done, #3)*
   **2b:** the file tools, on a host copy kept in sync with the sandbox, so omp's own tools and their snapshot tags keep working; `eval`, `debug`, `lsp`, `task` and `ast_edit` refused. *(done, #5 and #6)*
3. A prototype in a throwaway omp agent dir, driven by a scripted provider (no model tokens). It answers whether approvals (interactive prompts) and the output minimizer still work with replaced tools, what other paths to host execution remain (`!` commands, xd:// devices, MCP, plugins), and how fast the sync is at repo size. *(done; answers above and on gitmoot#2678)*
4. The `gitmoot workspace` backend. **4a:** commands (`open`, `ws sh`, `exec`) against gitmoot's slice 1. *(done, #8)* **4b:** files and sync against slice 2, and `OMP_SANDBOX_BACKEND=gitmoot`. *(done, #10)* **4c:** slice 2 as merged: plain `--cwd`, `.git` at any depth never mirrored. *(done, #11)*
5. ssh and docker backends.

## Safety
**Never install this into `~/.omp/agent/extensions`.** Every omp session for that user loads that directory. Load it explicitly instead, with `omp --extension <path>` or `--trusted-extension <abs-path>`.

## Security

**Fixed in #18 (`5c58d685`): host files readable through `read` path lists.**
- **Affected:** `main` before `5c58d685`.
- **Exposure:** read-only. A `read` call could return the contents of a host file outside the sandboxed copy, by naming it inside a path list or an encoded path. No file could be written outside the copy.
- **Cause:** omp's `read` splits and decodes some path strings at execution, while the add-on checked only the path as a whole.
- **Fix:** every file tool now takes one plain path per call. Paths containing list separators, braces, backslashes, `%`-escapes or `file://` are refused, and each remaining path must lie inside the copy.
- **Action:** if you ran an earlier version, update to `main` at or after `5c58d685`.

Please do not open a public issue for a security problem; contact the repository owner first.
