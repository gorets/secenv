#!/usr/bin/env bash
# Uninstall secenv: the CLI, the zsh completion and (on confirmation) the data.
#
#   ./uninstall.sh              asks before deleting data
#   ./uninstall.sh --keep-data  remove only the CLI and completion, keep data
#   ./uninstall.sh --purge      remove everything without asking
#
# age and age-plugin-se (Homebrew) are left alone: others may depend on them.
set -euo pipefail

BIN_DIR="${SECENV_BIN_DIR:-$HOME/.local/bin}"
DATA_DIR="${SECENV_HOME:-$HOME/.config/secenv}"
MODE=ask

for arg in "$@"; do
  case "$arg" in
    --keep-data) MODE=keep ;;
    --purge)     MODE=purge ;;
    -h|--help)   sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "✗ Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

ok() { echo "✓ $*"; }

if [[ -e "$BIN_DIR/secenv" ]]; then
  rm -f "$BIN_DIR/secenv"
  ok "removed $BIN_DIR/secenv"
fi

if command -v brew >/dev/null; then
  COMP="$(brew --prefix)/share/zsh/site-functions/_secenv"
  if [[ -e "$COMP" ]]; then
    rm -f "$COMP"
    ok "removed $COMP"
  fi
fi

if [[ -d "$DATA_DIR" ]]; then
  if [[ "$MODE" == ask ]]; then
    echo
    echo "$DATA_DIR holds the encrypted profiles and the reference to the Secure Enclave key."
    echo "After deletion the profiles can NOT be decrypted."
    read -r -p "Delete the data? [y/N] " answer
    [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] && MODE=purge || MODE=keep
  fi
  if [[ "$MODE" == purge ]]; then
    rm -rf "$DATA_DIR"
    ok "removed $DATA_DIR"
  else
    echo "• data kept: $DATA_DIR"
  fi
fi

echo
echo "age and age-plugin-se were left installed. If you no longer need them:"
echo "  brew uninstall age-plugin-se age"
