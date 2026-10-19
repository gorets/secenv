#!/usr/bin/env bash
# Install secenv: age + age-plugin-se + the CLI in ~/.local/bin.
# macOS on Apple Silicon only (needs the Secure Enclave and Touch ID).
set -euo pipefail

BIN_DIR="${SECENV_BIN_DIR:-$HOME/.local/bin}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { echo "✗ $*" >&2; exit 1; }
ok()   { echo "✓ $*"; }

[[ "$(uname -s)" == "Darwin" ]] || fail "macOS is required."
[[ "$(uname -m)" == "arm64"  ]] || fail "Apple Silicon is required (Secure Enclave)."
command -v brew >/dev/null     || fail "Homebrew not found (https://brew.sh)."

# Node 22+: the CLI is installed without the .mjs extension and relies on
# Node detecting ES module syntax in extensionless files (22.7+ / 20.19+).
command -v node >/dev/null || fail "Node.js not found (version 22+ required)."
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' \
  || fail "Node.js 22+ is required, found $(node -v)."
ok "Node $(node -v)"

# age
if ! command -v age >/dev/null; then brew install age; fi
ok "age $(age --version)"

# age-plugin-se
if ! command -v age-plugin-se >/dev/null; then
  # Plugin source: https://github.com/remko/age-plugin-se (formula in homebrew-core)
  brew install age-plugin-se \
    || fail "Could not install age-plugin-se. Install it following the plugin README and run this script again."
fi
ok "age-plugin-se installed"

# CLI
mkdir -p "$BIN_DIR"
install -m 755 "$SRC_DIR/src/secenv.mjs" "$BIN_DIR/secenv"
ok "secenv -> $BIN_DIR/secenv"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "! Add to ~/.zshrc: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# zsh completion (Homebrew's site-functions is on fpath for most setups)
COMP_DIR="$(brew --prefix)/share/zsh/site-functions"
if [[ -d "$COMP_DIR" ]]; then
  install -m 644 "$SRC_DIR/src/completions/_secenv" "$COMP_DIR/_secenv"
  ok "zsh completion -> $COMP_DIR/_secenv (open a new terminal; if it does not work: rm -f ~/.zcompdump* && compinit)"
fi

# Secure Enclave key (if there is none yet)
"$BIN_DIR/secenv" init
echo
echo "Next: secenv set myapp/OPENAI_API_KEY   (or secenv import myapp)"
