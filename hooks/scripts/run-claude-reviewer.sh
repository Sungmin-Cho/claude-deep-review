#!/usr/bin/env bash
# Run the deep-review Claude reviewer from non-Claude runtimes such as Codex.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: run-claude-reviewer.sh --project-root DIR --plugin-root DIR --prompt-file FILE [options]

Options:
  --output FILE       Write Claude reviewer stdout to FILE.
  --model MODEL       Claude model alias to use (default: opus).
  --agent NAME        Claude Code agent name (default: code-reviewer).
  --timeout SECONDS   Timeout for the reviewer process (default: 1200).
  --dry-run           Print the resolved execution fields and exit.
  -h, --help          Show this help.
EOF
}

timeout_run() {
  local sec="$1"
  shift
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$sec" "$@"
    return
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$sec" "$@"
    return
  fi
  # BLOCKER-1/N3 fix: shift $seconds before fork so child's @ARGV is the actual command.
  perl -e '
    my $seconds = shift @ARGV;
    my $pid = fork;
    if (!defined $pid) { die "fork: $!" }
    if (!$pid) { exec @ARGV; die "exec: $!" }
    alarm $seconds;
    $SIG{ALRM} = sub { kill 15, $pid; exit 124 };
    wait;
    exit ($? >> 8)
  ' "$sec" "$@"
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_plugin_root="$(cd "$script_dir/../.." && pwd)"

project_root=""
plugin_root="$default_plugin_root"
prompt_file=""
output_file=""
model="opus"
agent="code-reviewer"
timeout_seconds="${REVIEW_TIMEOUT_SECONDS:-1200}"
dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-root)
      project_root="${2:-}"
      shift 2
      ;;
    --plugin-root)
      plugin_root="${2:-}"
      shift 2
      ;;
    --prompt-file)
      prompt_file="${2:-}"
      shift 2
      ;;
    --output)
      output_file="${2:-}"
      shift 2
      ;;
    --model)
      model="${2:-}"
      shift 2
      ;;
    --agent)
      agent="${2:-}"
      shift 2
      ;;
    --timeout)
      timeout_seconds="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "run-claude-reviewer.sh: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$project_root" ]; then
  project_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

if [ -z "$prompt_file" ]; then
  echo "run-claude-reviewer.sh: --prompt-file is required" >&2
  exit 2
fi

case "$timeout_seconds" in
  ''|*[!0-9]*)
    echo "run-claude-reviewer.sh: --timeout must be a positive integer" >&2
    exit 2
    ;;
esac
if [ "$timeout_seconds" -le 0 ]; then
  echo "run-claude-reviewer.sh: --timeout must be a positive integer" >&2
  exit 2
fi

if [ ! -d "$project_root" ]; then
  echo "run-claude-reviewer.sh: project root not found: $project_root" >&2
  exit 2
fi
project_root="$(cd "$project_root" && pwd)"
if [ ! -d "$plugin_root" ]; then
  echo "run-claude-reviewer.sh: plugin root not found: $plugin_root" >&2
  exit 2
fi
plugin_root="$(cd "$plugin_root" && pwd)"
if [ ! -f "$plugin_root/agents/$agent.md" ]; then
  echo "run-claude-reviewer.sh: agent not found: $plugin_root/agents/$agent.md" >&2
  exit 2
fi
if [ ! -r "$prompt_file" ]; then
  echo "run-claude-reviewer.sh: prompt file not readable: $prompt_file" >&2
  exit 2
fi
prompt_file="$(cd "$(dirname "$prompt_file")" && pwd)/$(basename "$prompt_file")"
if [ -n "$output_file" ]; then
  mkdir -p "$(dirname "$output_file")"
  output_file="$(cd "$(dirname "$output_file")" && pwd)/$(basename "$output_file")"
fi

claude_bin="$(command -v claude || true)"
if [ -z "$claude_bin" ]; then
  echo "run-claude-reviewer.sh: claude CLI not found in PATH" >&2
  exit 127
fi

if [ "$dry_run" -eq 1 ]; then
  printf 'claude_cli_path=%s\n' "$claude_bin"
  printf 'agent=%s\n' "$agent"
  printf 'model=%s\n' "$model"
  printf 'plugin_root=%s\n' "$plugin_root"
  printf 'project_root=%s\n' "$project_root"
  printf 'prompt_file=%s\n' "$prompt_file"
  printf 'output_file=%s\n' "$output_file"
  printf 'timeout_seconds=%s\n' "$timeout_seconds"
  exit 0
fi

cmd=(
  "$claude_bin"
  -p
  --plugin-dir "$plugin_root"
  --agent "$agent"
  --model "$model"
  --permission-mode dontAsk
  --add-dir "$project_root"
  --tools "Read,Glob,Grep,Bash"
  --output-format text
)

if [ -n "$output_file" ]; then
  (cd "$project_root" && timeout_run "$timeout_seconds" "${cmd[@]}" < "$prompt_file" > "$output_file")
else
  (cd "$project_root" && timeout_run "$timeout_seconds" "${cmd[@]}" < "$prompt_file")
fi
