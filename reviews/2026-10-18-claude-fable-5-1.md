# secenv review

- **Model:** Claude Fable 5.1 (`claude-fable-5-1`)
- **Date:** 2026-10-18
- **State:** after the fixes made in the same session. Reviewed: `src/secenv.mjs`, `src/completions/_secenv`, `install.sh`, `uninstall.sh`, `README.md` in the project folder.

## How it was checked

- Full read of every file.
- Command runs with a fake `age` (a shim that copies data without encrypting): `set`, `import`, `list`, `get`, `rm`, `run`, error handling.
- Interactive paths through `expect` with a pseudo-terminal: hidden input of `set`, `get` output to a terminal, `.secenv` confirmation (answers `y` and `n`, repeat run without a prompt).
- Running the extensionless copy on Node 20.18, 20.19, 22.16 and 24.16 (binaries from `~/.nvm`); the version gate in `install.sh` on Node 20.18.
- A search for Cyrillic in all scripts.

**Not checked:** real decryption through the Secure Enclave and Touch ID (the user verified it by hand earlier: `set → run` worked with a real key), `uninstall.sh` in its deleting mode (it would remove the working installation), Tab completion in a live terminal.

## What works

- The full command set: `init`, `set`, `import`, `list`, `get`, `rm`, `run`.
- `get` prints the value only to a terminal; into a pipe or `$(...)` it refuses with a hint, and `--allow-pipe` lifts the refusal. The check runs before decryption, so a refusal does not trigger Touch ID.
- `.secenv` confirmation: the question is asked once, the answer is stored in `trusted.json`, the next run goes through without a prompt, `n` cancels, and without a terminal the run is refused. The name from the file is validated before any message, so a multi-line or invalid file gives `invalid profile name in …/.secenv`.
- `run` returns the child's exit code; if the child dies from a signal, it returns `128 + signal number` (SIGTERM → 143).
- `--public-env` with no file or a missing file ends with an error.
- Running the script from a path containing a space works.
- Piped input: a single key gets the whole input (multi-line is fine), several keys get one line each, and a shortage of lines gives a clear error.
- File permissions: directory `0700`; `identity.txt`, `recipient.txt` and profiles `0600`.
- Atomic profile writes through a temporary file and `rename`.
- `install.sh` requires Node 22+ and stops on older versions with a clear error. The script also runs on Node 20.19+, but the threshold of 22 was chosen to keep the rule simple.
- No Cyrillic left in any script or comment.

## What remains (non-blocking)

- `decryptFrom` calls `need('age')` on every decryption (an extra `spawnSync age --version`), while `encryptTo` does not check at all. One check at the start of the commands that use `age` would be enough.
- Encrypting to an `age1se1…` recipient also needs `age-plugin-se` on PATH, but `need('age-plugin-se')` exists only in `init`. Without the plugin the user sees a raw `age` error followed by "could not encrypt".
- `let pipedLines` is declared after the function that uses it. It works, but reads badly: move it next to `pipedInput`.
- In hidden input, arrow keys add escape sequences to the value. That does not matter for pasting from the clipboard, but it does for manual editing.
- With `stdio: 'inherit'`, `Ctrl-C` reaches the child twice: from the terminal and from secenv's forwarding handler. Harmless for most programs.
- Completion does not offer key names for `get`/`rm` (that would need Touch ID, so this is deliberate) and does not know the `profile/KEY` form.

## README

Checked against the code: requirements, profile selection order, variable precedence, file list, `get` behaviour and the pipe refusal, exit codes, Troubleshooting, and the description of `uninstall.sh` all match the implementation. The clone URL in the Install section now points at the `origin` remote.

## Verdict

The tool does what it claims, and the main scenario (`set` → `run` under Touch ID) is confirmed on real hardware. There are no blocking problems. Before sharing with colleagues, reinstall the local copy with `./install.sh`: at review time `~/.local/bin` held the version from before the fixes.
