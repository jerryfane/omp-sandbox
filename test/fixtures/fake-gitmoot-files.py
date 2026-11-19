#!/usr/bin/env python3
"""Stand-in for gitmoot's workspace file commands (WORKSPACES.md "Files" on
feat/workspace-files 010c565d, plus `remove` as announced in message 515408):
read, write, stat, changes, pull, push --files, remove. Called by
fake-gitmoot.sh as: fake-gitmoot-files.py <root> <id> <command> <args...>.

Confinement as documented: a <rel> is taken exactly as given ("" is the
root); an absolute path, a `..` component or a symlink anywhere on the way is
refused with cwd_outside_root (a final symlink too, except for stat and
remove). `changes` always answers reset:true with the whole tree, which the
contract allows (it may over-report, never under-report).
"""
import io
import json
import os
import stat
import sys
import tarfile


def fail(code, message, status=125):
    print(json.dumps({"error": {"code": code, "message": message}}), file=sys.stderr)
    sys.exit(status)


def parts_of(rel):
    if rel.startswith("/"):
        fail("cwd_outside_root", f"{rel} is absolute")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if ".." in parts:
        fail("cwd_outside_root", f"{rel} leaves the root")
    return parts


def walk_to_parent(root, parts, rel):
    """The real path of the parent of parts, refusing any symlink on the way."""
    current = root
    for p in parts[:-1]:
        current = os.path.join(current, p)
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(info.st_mode):
            fail("cwd_outside_root", f"{rel} goes through a symlink")
        if not stat.S_ISDIR(info.st_mode):
            fail("cwd_outside_root", f"{rel} goes through a file")
    return current


def target(root, rel, allow_final_symlink=False):
    parts = parts_of(rel)
    if not parts:
        return root, os.lstat(root)
    parent = walk_to_parent(root, parts, rel)
    if parent is None:
        return None, None
    full = os.path.join(parent, parts[-1])
    try:
        info = os.lstat(full)
    except FileNotFoundError:
        return full, None
    if stat.S_ISLNK(info.st_mode) and not allow_final_symlink:
        fail("cwd_outside_root", f"{rel} is a symlink")
    return full, info


def kind(mode):
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"


def tree(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == ".":
            dirnames[:] = [d for d in dirnames if d != ".git"]
        for name in sorted(dirnames + filenames):
            rel = name if rel_dir == "." else f"{rel_dir}/{name}"
            info = os.lstat(os.path.join(dirpath, name))
            # The raw st_mode (type bits included): WORKSPACES.md does not promise permission bits only.
            out.append({"path": rel, "type": kind(info.st_mode), "size": info.st_size if not stat.S_ISDIR(info.st_mode) else 0, "mtime": info.st_mtime, "mode": info.st_mode})
        # os.walk does not descend into symlinked directories by default
    return sorted(out, key=lambda e: e["path"].encode())


def main():
    root, workspace, command, *args = sys.argv[1:]
    flags = {}
    positional = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            positional.extend(args[i + 1:])
            break
        if a in ("--home", "--mode", "--since"):
            flags[a] = args[i + 1]
            i += 2
            continue
        if a in ("--json", "--files"):
            flags[a] = True
            i += 1
            continue
        positional.append(a)
        i += 1
    if not positional or positional[0] != workspace:
        fail("not_found", f"no workspace {positional[0] if positional else ''}")
    positional = positional[1:]

    if command == "read":
        full, info = target(root, positional[0])
        if info is None:
            fail("not_found", f"{positional[0]} does not exist", 3)
        if stat.S_ISDIR(info.st_mode):
            fail("is_directory", f"{positional[0]} is a directory", 4)
        with open(full, "rb") as f:
            sys.stdout.buffer.write(f.read())
    elif command == "write":
        rel = positional[0]
        parts = parts_of(rel)
        if not parts:
            fail("is_directory", "the root is a directory", 4)
        parent_parts = []
        for p in parts[:-1]:
            parent_parts.append(p)
            walk_to_parent(root, parent_parts + ["x"], rel)
            os.makedirs(os.path.join(root, *parent_parts), exist_ok=True)
        full, info = target(root, rel)
        if info is not None and stat.S_ISDIR(info.st_mode):
            fail("is_directory", f"{rel} is a directory", 4)
        mode = int(flags["--mode"], 8) if "--mode" in flags else (info.st_mode & 0o7777 if info is not None else 0o644)
        tmp = f"{full}.fake-tmp"
        with open(tmp, "wb") as f:
            f.write(sys.stdin.buffer.read())
        os.chmod(tmp, mode)
        os.replace(tmp, full)
    elif command == "stat":
        full, info = target(root, positional[0], allow_final_symlink=True)
        if info is None:
            fail("not_found", f"{positional[0]} does not exist", 3)
        print(json.dumps({"type": kind(info.st_mode), "size": info.st_size, "mtime": info.st_mtime}))
    elif command == "changes":
        print(json.dumps({"reset": True, "token": f"ws1.fake-{os.getpid()}", "changed": tree(root), "deleted": []}))
    elif command == "pull":
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as tar:
            for rel in positional:
                parts = parts_of(rel)
                if not parts:
                    continue
                parent = root
                skip = False
                for p in parts[:-1]:
                    parent = os.path.join(parent, p)
                    if not os.path.isdir(parent) or os.path.islink(parent):
                        skip = True
                        break
                full = os.path.join(root, *parts)
                if skip or not os.path.lexists(full):
                    continue
                info = os.lstat(full)
                if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                    continue
                tar.add(full, arcname="/".join(parts), recursive=False)
        sys.stdout.buffer.write(buffer.getvalue())
    elif command == "push":
        if not flags.get("--files"):
            fail("invalid_args", "fake gitmoot only implements push --files")
        with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()), mode="r") as tar:
            members = tar.getmembers()
            for m in members:  # the whole stream is checked first
                parts = parts_of(m.name)
                if not parts:
                    fail("cwd_outside_root", f"entry {m.name} names the root")
                walk_to_parent(root, parts, m.name)
                full = os.path.join(root, *parts)
                if os.path.islink(full):
                    fail("cwd_outside_root", f"entry {m.name} is a symlink; workspace writes never replace or follow one")
                if m.isfile() and os.path.isdir(full):
                    fail("is_directory", f"entry {m.name} is a directory")
                if m.issym():
                    fail("invalid_args", "the fake does not push symlinks")
            for m in members:
                full = os.path.join(root, *parts_of(m.name))
                if m.isdir():
                    os.makedirs(full, exist_ok=True)
                    os.chmod(full, m.mode & 0o7777)
                    continue
                os.makedirs(os.path.dirname(full), exist_ok=True)
                tmp = f"{full}.fake-tmp"
                with open(tmp, "wb") as f:
                    f.write(tar.extractfile(m).read())
                os.chmod(tmp, m.mode & 0o7777)
                os.replace(tmp, full)
        print(json.dumps({"applied": len(members)}))
    elif command == "remove":
        # Every path is checked before any is removed; a directory counts as
        # empty when each of its entries is listed before it in the batch.
        plan = []
        earlier = set()
        for rel in positional:
            parts = parts_of(rel)
            if not parts:
                fail("cwd_outside_root", "the root may not be removed")
            if parts[0] == ".git":
                fail("invalid_args", f"{rel} is under .git")
            full, info = target(root, rel, allow_final_symlink=True)
            norm = "/".join(parts)
            if info is not None:
                if stat.S_ISDIR(info.st_mode) and any(f"{norm}/{name}" not in earlier for name in os.listdir(full)):
                    fail("not_empty", f"{rel} is not empty")
                plan.append((full, stat.S_ISDIR(info.st_mode)))
            earlier.add(norm)
        for full, is_dir in plan:
            if is_dir:
                os.rmdir(full)
            else:
                os.unlink(full)
        print(json.dumps({"removed": len(plan)}))
    else:
        fail("invalid_args", f"fake gitmoot does not implement workspace {command}")


main()
