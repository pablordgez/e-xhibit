#!/usr/bin/env bash
set -euo pipefail
scanner_dir="$(mktemp -d)"
trap 'rm -rf -- "$scanner_dir"' EXIT
curl --fail --silent --show-error --location \
  'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz' \
  --output "$scanner_dir/gitleaks.tar.gz"
printf '%s  %s\n' '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' "$scanner_dir/gitleaks.tar.gz" | sha256sum --check --strict
tar -xzf "$scanner_dir/gitleaks.tar.gz" -C "$scanner_dir" gitleaks
"$scanner_dir/gitleaks" git . --log-opts='--all --full-history' --redact --max-decode-depth=3 --ignore-gitleaks-allow --no-banner
"$scanner_dir/gitleaks" dir . --redact --max-decode-depth=3 --ignore-gitleaks-allow --no-banner
