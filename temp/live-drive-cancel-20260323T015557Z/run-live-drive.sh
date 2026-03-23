#!/usr/bin/env bash
set -u -o pipefail

cd /home/bitzaven/CodingProjects/pi-threads || exit 1

evidence_dir="temp/live-drive-cancel-20260323T015557Z"
stdout_file="$evidence_dir/outer.stdout.jsonl"
stderr_file="$evidence_dir/outer.stderr.log"
outer_cmd_file="$evidence_dir/outer.command.txt"
outer_pid_file="$evidence_dir/outer.pid"
outer_initial_ps="$evidence_dir/outer.initial.ps.txt"
outer_before_sigint_ps="$evidence_dir/outer.before-sigint.ps.txt"
outer_after_wait_ps="$evidence_dir/outer.after-wait.ps.txt"
outer_exit_status_file="$evidence_dir/outer.exit-status.txt"
children_snapshot_file="$evidence_dir/children.direct.before-sigint.ps.txt"
children_pids_file="$evidence_dir/children.direct.pids.txt"
descendants_snapshot_file="$evidence_dir/children.descendants.before-sigint.ps.txt"
descendants_pids_file="$evidence_dir/children.descendants.pids.txt"
children_after_wait_ps="$evidence_dir/children.direct.after-wait.ps.txt"
descendants_after_wait_ps="$evidence_dir/children.descendants.after-wait.ps.txt"
alive_children_after_wait_file="$evidence_dir/children.direct.alive-after-wait.txt"
outer_pstree_before="$evidence_dir/outer.before-sigint.pstree.txt"
cleanup_log="$evidence_dir/cleanup.log"
timeline_file="$evidence_dir/timeline.txt"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$timeline_file" >/dev/null
}

collect_descendants() {
  declare -A seen=()
  local queue=("$@")
  local next=()
  local out=()
  while [ ${#queue[@]} -gt 0 ]; do
    next=()
    for pid in "${queue[@]}"; do
      [ -n "$pid" ] || continue
      while IFS= read -r child; do
        [ -n "$child" ] || continue
        if [ -n "${seen[$child]+x}" ]; then
          continue
        fi
        seen[$child]=1
        out+=("$child")
        next+=("$child")
      done < <(pgrep -P "$pid" || true)
    done
    queue=("${next[@]}")
  done
  if [ ${#out[@]} -gt 0 ]; then
    printf '%s\n' "${out[@]}"
  fi
}

write_ps_snapshot() {
  local output_file="$1"
  shift
  if [ $# -eq 0 ]; then
    : > "$output_file"
    return
  fi
  local joined
  joined=$(IFS=,; echo "$*")
  ps -o pid=,ppid=,pgid=,sid=,stat=,etime=,args= -p "$joined" > "$output_file" || true
}

kill_pids_if_alive() {
  local signal="$1"
  shift
  local pid
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    if kill -0 "$pid" 2>/dev/null; then
      kill "-$signal" "$pid" 2>/dev/null || true
      printf '%s sent %s to pid %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$signal" "$pid" >> "$cleanup_log"
    fi
  done
}

wait_status=""
outer_pid=""
declare -a child_pids=()
declare -a descendant_pids=()
declare -a alive_child_pids=()

action_prompt=$(cat <<'EOF'
Use the dispatch tool exactly once in batch mode with exactly these 3 tasks and nothing else.

tasks:
1. thread bugabort-a: Use bash to run `sleep 30; printf 'BUGABORT-A-MARKER\n'`. After it finishes, reply with exactly BUGABORT-A-MARKER.
2. thread bugabort-b: Use bash to run `sleep 30; printf 'BUGABORT-B-MARKER\n'`. After it finishes, reply with exactly BUGABORT-B-MARKER.
3. thread bugabort-c: Use bash to run `sleep 30; printf 'BUGABORT-C-MARKER\n'`. After it finishes, reply with exactly BUGABORT-C-MARKER.
EOF
)

log "starting outer pi process"
outer_cmd=(
  /home/bitzaven/.npm-global/bin/pi
  --no-extensions
  -e ./index.ts
  --no-skills
  --no-prompt-templates
  --model openai-codex/gpt-5.3-codex
  --mode json
  -p
  --no-session
  "$action_prompt"
)
printf '%q ' "${outer_cmd[@]}" > "$outer_cmd_file"
printf '\n' >> "$outer_cmd_file"

"${outer_cmd[@]}" > "$stdout_file" 2> "$stderr_file" &
outer_pid=$!
printf '%s\n' "$outer_pid" > "$outer_pid_file"
write_ps_snapshot "$outer_initial_ps" "$outer_pid"
log "outer pid $outer_pid started"

end_wait=$((SECONDS + 20))
while [ $SECONDS -lt $end_wait ]; do
  if ! kill -0 "$outer_pid" 2>/dev/null; then
    log "outer pid $outer_pid exited before 3 direct children were observed"
    break
  fi

  mapfile -t child_lines < <(ps -o pid=,ppid=,pgid=,sid=,stat=,etime=,args= --ppid "$outer_pid")
  mapfile -t child_pids < <(printf '%s\n' "${child_lines[@]}" | awk 'NF {print $1}')

  if [ ${#child_pids[@]} -ge 3 ]; then
    printf '%s\n' "${child_lines[@]}" > "$children_snapshot_file"
    printf '%s\n' "${child_pids[@]}" > "$children_pids_file"
    log "observed ${#child_pids[@]} direct children for outer pid $outer_pid: ${child_pids[*]}"
    break
  fi
  sleep 1
done

if [ ! -s "$children_pids_file" ]; then
  mapfile -t child_lines < <(ps -o pid=,ppid=,pgid=,sid=,stat=,etime=,args= --ppid "$outer_pid")
  mapfile -t child_pids < <(printf '%s\n' "${child_lines[@]}" | awk 'NF {print $1}')
  printf '%s\n' "${child_lines[@]}" > "$children_snapshot_file"
  if [ ${#child_pids[@]} -gt 0 ]; then
    printf '%s\n' "${child_pids[@]}" > "$children_pids_file"
  else
    : > "$children_pids_file"
  fi
  log "timeout/early-exit snapshot captured with ${#child_pids[@]} direct children"
fi

if [ ${#child_pids[@]} -gt 0 ]; then
  mapfile -t descendant_pids < <(collect_descendants "${child_pids[@]}")
fi
if [ ${#descendant_pids[@]} -gt 0 ]; then
  printf '%s\n' "${descendant_pids[@]}" > "$descendants_pids_file"
  write_ps_snapshot "$descendants_snapshot_file" "${descendant_pids[@]}"
else
  : > "$descendants_pids_file"
  : > "$descendants_snapshot_file"
fi

write_ps_snapshot "$outer_before_sigint_ps" "$outer_pid"
pstree -ap "$outer_pid" > "$outer_pstree_before" 2>/dev/null || true

log "sending SIGINT to outer pid $outer_pid"
kill -INT "$outer_pid" 2>/dev/null || true

post_sigint_deadline=$((SECONDS + 15))
while [ $SECONDS -lt $post_sigint_deadline ]; do
  if [ -z "$wait_status" ] && ! kill -0 "$outer_pid" 2>/dev/null; then
    wait "$outer_pid"
    wait_status="$?"
    log "outer pid $outer_pid exited with status $wait_status"
  fi

  alive_child_pids=()
  for pid in "${child_pids[@]}"; do
    [ -n "$pid" ] || continue
    if kill -0 "$pid" 2>/dev/null; then
      alive_child_pids+=("$pid")
    fi
  done

  if [ -n "$wait_status" ] && [ ${#alive_child_pids[@]} -eq 0 ]; then
    break
  fi
  sleep 1
done

if [ -z "$wait_status" ]; then
  if kill -0 "$outer_pid" 2>/dev/null; then
    wait_status="still-running-after-15s"
    log "outer pid $outer_pid still running after 15s"
  else
    wait "$outer_pid"
    wait_status="$?"
    log "outer pid $outer_pid exited with status $wait_status at end of 15s window"
  fi
fi
printf '%s\n' "$wait_status" > "$outer_exit_status_file"

alive_child_pids=()
for pid in "${child_pids[@]}"; do
  [ -n "$pid" ] || continue
  if kill -0 "$pid" 2>/dev/null; then
    alive_child_pids+=("$pid")
  fi
done
printf '%s\n' "${alive_child_pids[@]}" > "$alive_children_after_wait_file"

write_ps_snapshot "$outer_after_wait_ps" "$outer_pid"
write_ps_snapshot "$children_after_wait_ps" "${child_pids[@]}"
if [ ${#descendant_pids[@]} -gt 0 ]; then
  write_ps_snapshot "$descendants_after_wait_ps" "${descendant_pids[@]}"
else
  : > "$descendants_after_wait_ps"
fi

cleanup_targets=()
if [ "$wait_status" = "still-running-after-15s" ] && kill -0 "$outer_pid" 2>/dev/null; then
  cleanup_targets+=("$outer_pid")
fi
for pid in "${child_pids[@]}" "${descendant_pids[@]}"; do
  [ -n "$pid" ] || continue
  if kill -0 "$pid" 2>/dev/null; then
    cleanup_targets+=("$pid")
  fi
done

if [ ${#cleanup_targets[@]} -gt 0 ]; then
  log "cleanup required for pids: ${cleanup_targets[*]}"
  kill_pids_if_alive TERM "${cleanup_targets[@]}"
  sleep 2
  kill_pids_if_alive KILL "${cleanup_targets[@]}"
else
  log "no cleanup kill needed for recorded pids"
fi

log "run complete"
