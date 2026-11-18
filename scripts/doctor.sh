#!/usr/bin/env bash
# Checks what this machine can run: tests, `pnpm demo`, the UI + agent, webhooks.
# Linux and macOS (bash 3.2+). Never prints a secret value, never installs system packages.
#   ./scripts/doctor.sh          report only
#   ./scripts/doctor.sh --fix    also offer safe local steps (corepack enable, pnpm install,
#                                cp .env.example .env), each after a y/N question
set -euo pipefail

FIX=0
case "${1:-}" in
  --fix) FIX=1 ;;
  "") ;;
  -h | --help)
    sed -n '2,6p' "$0"
    exit 0
    ;;
  *)
    echo "Unknown option: $1 (use --fix or --help)" >&2
    exit 2
    ;;
esac

cd "$(dirname "$0")/.."
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
OS="$(uname -s)"

ok() { printf '  \342\234\223 %s\n' "$1"; }
bad() { printf '  \342\234\227 %s\n      fix: %s\n' "$1" "$2"; }
opt() { printf '  - %s\n      to enable: %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Ask y/N; only with --fix and an interactive terminal. Anything but y/yes is no.
confirm() {
  [ "$FIX" = 1 ] || return 1
  if [ ! -t 0 ]; then
    echo "      (--fix: not a terminal, skipped; run it yourself)"
    return 1
  fi
  local answer
  printf '      %s [y/N] ' "$1"
  read -r answer || return 1
  case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# The effective value of a variable, as the app sees it: the shell first (it wins over .env, as
# with Node's loadEnvFile), else the last KEY=... line in .env, quotes stripped. Never printed.
env_value() {
  local v="${!1:-}" line
  if [ -z "$v" ] && [ -f .env ]; then
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" .env | tail -n 1 || true)"
    v="${line#*=}"
    v="${v%"${v##*[![:space:]]}"}"
    case "$v" in \"*\" | \'*\') v="${v:1:${#v}-2}" ;; esac
  fi
  printf '%s' "$v"
}

CAN_TESTS=1 CAN_DEMO=1 CAN_UI=1 CAN_WEBHOOKS=1

echo "Toolchain"
if have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]; then
  ok "Node $(node -v)"
else
  bad "Node 24 or newer (found: $(node -v 2>/dev/null || echo none))" \
    "nvm install 24 / fnm install 24 / brew install node@24"
  CAN_TESTS=0
fi

pnpm_ok() { have pnpm && case "$(pnpm -v 2>/dev/null)" in 9.*) true ;; *) false ;; esac; }
if pnpm_ok; then
  ok "pnpm $(pnpm -v)"
else
  bad "pnpm 9 (found: $(pnpm -v 2>/dev/null || echo none))" "corepack enable   (ships with Node; package.json pins pnpm 9)"
  if have corepack && confirm "Run 'corepack enable' now?"; then corepack enable && pnpm_ok && ok "pnpm $(pnpm -v)"; fi
  pnpm_ok || CAN_TESTS=0
fi

deps_ok() { [ -f node_modules/.modules.yaml ] && [ -x node_modules/.bin/vitest ]; }
if deps_ok; then
  ok "dependencies installed (node_modules)"
else
  bad "dependencies not installed" "pnpm install"
  if pnpm_ok && confirm "Run 'pnpm install' now?"; then pnpm install && deps_ok && ok "dependencies installed"; fi
  deps_ok || CAN_TESTS=0
fi

echo "Oncade (.env; values are never shown)"
if [ -f .env ]; then
  ok ".env exists"
else
  bad ".env is missing" "cp .env.example .env   (then fill in ONCADE_API_KEY and ONCADE_BUSINESS_ID)"
  if confirm "Copy .env.example to .env now?"; then cp .env.example .env && ok ".env created from .env.example (fill in the keys)"; fi
fi

key="$(env_value ONCADE_API_KEY)"
case "$key" in
  oncade_platform_test_?*) ok "ONCADE_API_KEY is set and is a test key" ;;
  "")
    bad "ONCADE_API_KEY is not set" "dev.oncade.xyz -> Platforms -> API Keys, put the oncade_platform_test_... key in .env"
    CAN_DEMO=0
    ;;
  *)
    bad "ONCADE_API_KEY is not an Oncade TEST key" "use a key that starts with oncade_platform_test_ (live keys are refused)"
    CAN_DEMO=0
    ;;
esac
unset key
if [ -n "$(env_value ONCADE_BUSINESS_ID)" ]; then
  ok "ONCADE_BUSINESS_ID is set"
else
  bad "ONCADE_BUSINESS_ID is not set" "copy the business id from the developer portal into .env"
  CAN_DEMO=0
fi

echo "Optional"
if [ -n "$(env_value ONCADE_WEBHOOK_SECRET)" ]; then
  ok "ONCADE_WEBHOOK_SECRET is set"
else
  opt "ONCADE_WEBHOOK_SECRET is not set (webhooks get 401)" "dev.oncade.xyz Platform Settings -> webhook secret, into .env"
  CAN_WEBHOOKS=0
fi

NGROK_HINT="ngrok config add-authtoken <token>   (token: https://dashboard.ngrok.com/get-started/your-authtoken)"

# Does ngrok's authtoken actually work? Starts a tunnel to 127.0.0.1:65530 (nothing listens there,
# so nothing is exposed) for up to 8 s, reads only the status out of its log, then kills that exact
# PID. Prints "ok", "ERR_NGROK_<n>" or "unknown". The log is never shown (it may name the token).
ngrok_probe() {
  local log pid result=unknown
  log="$(mktemp)" || {
    echo unknown
    return
  }
  ngrok http 127.0.0.1:65530 --log stdout --log-format json >"$log" 2>&1 </dev/null &
  pid=$!
  for _ in 1 2 3 4 5 6 7 8; do
    sleep 1
    if grep -qE '"msg":"started tunnel"|"url":"https://' "$log"; then
      result=ok
      break
    fi
    if grep -qE 'ERR_NGROK_[0-9]+' "$log"; then
      result="$(grep -oE 'ERR_NGROK_[0-9]+' "$log" | head -n 1)"
      break
    fi
    kill -0 "$pid" 2>/dev/null || break # exited without a status we know
  done
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$log"
  echo "$result"
}

if have ngrok; then
  if ! ngrok config check >/dev/null 2>&1; then
    bad "ngrok config is invalid (ngrok config check fails)" "$NGROK_HINT"
    CAN_WEBHOOKS=0
  else
    probe="$(ngrok_probe)"
    case "$probe" in
      ok) ok "ngrok authtoken works (a test tunnel started and was stopped)" ;;
      ERR_NGROK_*)
        bad "ngrok authtoken rejected ($probe, https://ngrok.com/docs/errors/$(echo "$probe" | tr '[:upper:]' '[:lower:]'))" "$NGROK_HINT"
        CAN_WEBHOOKS=0
        ;;
      *)
        printf '  ? %s\n      if pnpm tunnel fails with ERR_NGROK_...: %s\n' \
          "ngrok authtoken: could not verify (no network, or ngrok gave no answer in 8 s)" "$NGROK_HINT"
        ;;
    esac
    unset probe
  fi
else
  opt "ngrok not found (needed for webhooks: pnpm tunnel)" \
    "$([ "$OS" = Darwin ] && echo 'brew install ngrok' || echo 'sudo snap install ngrok'), then ngrok config add-authtoken <token>"
  CAN_WEBHOOKS=0
fi

if [ -n "$(env_value ANTHROPIC_API_KEY)" ]; then
  ok "ANTHROPIC_API_KEY is set (the agent uses it)"
  have claude || {
    bad "claude CLI not found (the agent runs it)" "npm i -g @anthropic-ai/claude-code"
    CAN_UI=0
  }
elif have claude && claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  ok "claude CLI is logged in"
elif have claude; then
  opt "claude CLI found but not logged in, and no ANTHROPIC_API_KEY" "run 'claude' once to log in, or set ANTHROPIC_API_KEY in .env"
  CAN_UI=0
else
  opt "no LLM access: neither ANTHROPIC_API_KEY nor the claude CLI" "npm i -g @anthropic-ai/claude-code, then 'claude' to log in"
  CAN_UI=0
fi

if [ "$OS" = Linux ]; then
  if have bwrap; then
    ok "bwrap (agent sandbox)"
  else
    opt "bwrap not found (the agent runs unsandboxed with AGENT_SANDBOX=auto)" \
      "sudo apt install bubblewrap   or   sudo dnf install bubblewrap"
  fi
else
  ok "sandbox: bubblewrap is Linux-only; on $OS AGENT_SANDBOX=auto runs the agent without it"
fi

admin_pw="$(env_value ADMIN_PASSWORD)" secret="$(env_value SESSION_SECRET)"
if [ "${#admin_pw}" -ge 12 ] && [ "${#secret}" -ge 32 ]; then
  ok "ADMIN_PASSWORD and SESSION_SECRET are set (lengths ok)"
elif [ "$(env_value ALLOW_INSECURE_DEFAULTS)" = 1 ]; then
  ok "ALLOW_INSECURE_DEFAULTS=1: the UI starts with admin/admin (local demo only)"
else
  opt "UI login not configured (pnpm dev refuses to start)" \
    "set ADMIN_PASSWORD (12+ chars) and SESSION_SECRET (openssl rand -hex 32) in .env, or ALLOW_INSECURE_DEFAULTS=1 for a local demo"
  CAN_UI=0
  CAN_WEBHOOKS=0 # the webhook receiver is started by `pnpm dev` too
fi
unset admin_pw secret

[ "$CAN_TESTS" = 1 ] || { CAN_DEMO=0 CAN_UI=0 CAN_WEBHOOKS=0; }
[ "$CAN_DEMO" = 1 ] || { CAN_UI=0 CAN_WEBHOOKS=0; }

echo
echo "What you can run now"
line() { if [ "$1" = 1 ]; then ok "$2"; else printf '  \342\234\227 %s\n' "$2"; fi; }
line "$CAN_TESTS" "pnpm test                      (no keys needed)"
line "$CAN_DEMO" "pnpm demo                      (Oncade test key only)"
line "$CAN_UI" "pnpm dev, pnpm ask \"...\"       (UI and agent)"
line "$CAN_WEBHOOKS" "pnpm dev + pnpm tunnel         (real webhooks; then pnpm demo waits for them)"
[ "$FIX" = 1 ] || [ "$CAN_DEMO" = 1 ] || echo "  Tip: ./scripts/doctor.sh --fix offers the safe local steps."
[ "$CAN_TESTS" = 1 ]
