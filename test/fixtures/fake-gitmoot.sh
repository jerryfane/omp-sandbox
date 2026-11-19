#!/bin/bash
# A stand-in for the gitmoot CLI's workspace commands, following
# skills/gitmoot/references/WORKSPACES.md on gitmoot feat/workspace-cli
# (6e51895a). gitmoot's own fake provider lives only inside its Go tests, so
# the real binary cannot run offline. The "VM" is the directory
# $FAKE_GITMOOT_ROOT; commands run there with a clean environment.
# Configured by:
#   FAKE_GITMOOT_ROOT   the workspace root (stands in for /home/user/work)
#   FAKE_GITMOOT_ID     the workspace id (default ws-test)
#   FAKE_GITMOOT_STATE  the state `show` reports (default ready)
set -u
id=${FAKE_GITMOOT_ID:-ws-test}
status_file=
write_status() { # exit_code signal-or-null error-json-or-null
	[ -n "$status_file" ] || return 0
	printf '{"exit_code":%s,"signal":%s,"timed_out":false,"error":%s}\n' "$1" "$2" "$3" >"$status_file.tmp" && mv "$status_file.tmp" "$status_file"
}
fail() {
	local err
	err=$(printf '{"code":"%s","message":"%s"}' "$1" "$2")
	printf '{"error":%s}\n' "$err" >&2
	write_status 125 null "$err"
	exit 125
}
case "${1-} ${2-}" in
"workspace show")
	[ "${3-}" = "$id" ] || fail not_found "no workspace ${3-}"
	printf '{"id":"%s","seat":"t","repo":"o/r","issue":1,"pr":null,"branch":"b","base":"main","root":"%s","provider":"fake","state":"%s","created_at":"x","last_active_at":"x"}\n' \
		"$id" "$FAKE_GITMOOT_ROOT" "${FAKE_GITMOOT_STATE:-ready}"
	;;
"ws sh")
	shift 2
	cwd=.
	while [ $# -gt 1 ]; do
		case "$1" in
		--cwd) cwd=$2; shift 2 ;;
		--status-file) status_file=$2; shift 2 ;;
		--home) shift 2 ;;
		*) break ;;
		esac
	done
	[ $# -eq 1 ] || fail invalid_args "ws sh takes exactly one command string"
	[ "${GITMOOT_WORKSPACE-}" = "$id" ] || fail not_found "GITMOOT_WORKSPACE is ${GITMOOT_WORKSPACE-unset}"
	case "/$cwd/" in */../*) fail cwd_outside_root "$cwd" ;; esac
	case "$cwd" in /*) fail cwd_outside_root "$cwd" ;; esac
	dir="$FAKE_GITMOOT_ROOT/$cwd"
	[ -d "$dir" ] || fail invalid_args "no directory $cwd"
	cd "$dir" || fail internal "cd"
	/usr/bin/env -i HOME="$FAKE_GITMOOT_ROOT" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 GITMOOT_WORKSPACE_ROOT="$FAKE_GITMOOT_ROOT" /bin/bash -lc "$1" </dev/null
	status=$?
	if [ $status -gt 128 ]; then write_status null $((status - 128)) null; else write_status $status null null; fi
	exit $status
	;;
"workspace exec")
	[ "${3-}" = "$id" ] || fail not_found "no workspace ${3-}"
	shift 3
	cwd=.
	envs=()
	while [ $# -gt 0 ] && [ "$1" != "--" ]; do
		case "$1" in
		--cwd) cwd=$2; shift 2 ;;
		--env) envs+=("$2"); shift 2 ;;
		--status-file) status_file=$2; shift 2 ;;
		--home) shift 2 ;;
		*) fail invalid_args "unknown flag $1" ;;
		esac
	done
	[ "${1-}" = "--" ] && [ $# -ge 2 ] || fail invalid_args "workspace exec needs -- argv"
	shift
	case "/$cwd/" in */../*) fail cwd_outside_root "$cwd" ;; esac
	case "$cwd" in /*) fail cwd_outside_root "$cwd" ;; esac
	dir="$FAKE_GITMOOT_ROOT/$cwd"
	[ -d "$dir" ] || fail invalid_args "no directory $cwd"
	cd "$dir" || fail internal "cd"
	# Own session and process group, so SIGTERM to the CLI can reach the whole group (as documented).
	/usr/bin/setsid /usr/bin/env -i HOME="$FAKE_GITMOOT_ROOT" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 "${envs[@]}" "$@" </dev/null &
	pid=$!
	trap 'kill -TERM -- -$pid 2>/dev/null; (sleep 3; kill -KILL -- -$pid 2>/dev/null) &' TERM INT
	wait $pid
	status=$?
	while kill -0 $pid 2>/dev/null; do wait $pid; status=$?; done
	if [ $status -gt 128 ]; then write_status null $((status - 128)) null; else write_status $status null null; fi
	exit $status
	;;
*)
	fail invalid_args "fake gitmoot does not implement: $*"
	;;
esac
