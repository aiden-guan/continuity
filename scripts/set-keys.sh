#!/usr/bin/env bash
# Asks for API keys with hidden input and writes them to .env (which is gitignored).
# Pressing Enter at a prompt keeps whatever value is there now.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
chmod 600 .env

# write_key NAME VALUE: replace the NAME=... line in .env, or append one if it is missing.
# The value reaches awk through the environment, never as a command-line argument.
write_key() {
  local key="$1" secret="$2" scratch
  scratch="$(mktemp)"
  NAME="$key" VALUE="$secret" awk 'BEGIN { n = ENVIRON["NAME"]; v = ENVIRON["VALUE"]; found = 0 }
    index($0, n "=") == 1 { print n "=" v; found = 1; next }
    { print }
    END { if (!found) print n "=" v }' .env > "$scratch"
  mv "$scratch" .env
  chmod 600 .env
}

for key in ANTHROPIC_API_KEY PRIMITIVE_API_KEY; do
  read -rsp "$key (hidden; Enter to skip): " entered
  echo
  if [ -n "$entered" ]; then
    write_key "$key" "$entered"
    echo "  saved $key"
  else
    echo "  skipped $key"
  fi
done
unset entered
echo
npm run --silent check:keys
