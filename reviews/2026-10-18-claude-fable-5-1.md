# secenv security audit

- **Model:** Claude Fable 5.1 (`claude-fable-5-1`), with one independent reviewer agent (same model family) that received the code but none of the auditor's conclusions
- **Date:** 2026-10-18
- **State:** after the fixes made in the same session, i.e. the 0.5.0 working tree on top of commit `bf9c1a4`. Reviewed: `src/secenv.mjs`, `src/completions/_secenv`, `install.sh`, `uninstall.sh`, `package.json`, `README.md`, `CHANGELOG.md`.
- **Scope and method:** single-pass source audit against the trust boundaries below; every candidate was reproduced in a sandbox (`SECENV_HOME` in a scratch directory, `SECENV_TOOL_DIRS` pointing at a fake `age` that copies instead of encrypting, fake `npm`/`brew`, loopback HTTP servers, `expect` for the interactive prompts). No real key, no real secrets, no network, no Homebrew. This is not the full multi-agent audit workflow: one auditor, one independent reviewer, findings reconciled by hand, each fix re-tested with the reproduction that found the problem. Six findings were confirmed and fixed; what follows describes the state after the fixes. The findings themselves are summarised under "Security" in `CHANGELOG.md` for 0.5.0.

## Trust boundaries considered

| # | Lower-trust principal | What secenv promises |
| --- | --- | --- |
| B1 | A cloned repository (its `package.json` scripts, `.secenv`, `.env.public`, `node_modules`) | It cannot pick which secrets it receives without the user's explicit, informed approval; `run profile/KEY` limits it to the listed keys |
| B2 | Other local processes and users on the same Mac | Nothing in plaintext on disk; files `0600`/`0700`; secrets not in argv |
| B3 | The network: npm registry, raw.githubusercontent.com, Homebrew | `update` never changes the tool silently |
| B4 | Arguments, env vars, file names | No shell, no path traversal, no injection |

## Checked and found sound

### B1: a repository the user runs

- **Approval is per (directory, profile), whatever names the profile.** `secenv run <profile>`, `SECENV_PROFILE` and `.secenv` all go through `approveRun`, which asks on the terminal with the profile, its source and the full command, and stores the answer in `trusted.json` as `realpath(dir) → [profiles]`. Confirmed: in an unapproved directory an `npm start` script that says `secenv run app -- …` is refused without a terminal and prompts with one; after `y` the directory is stored; a second profile in the same directory prompts again; the legacy string format of `trusted.json` is still read.
- **The prompt goes to `/dev/tty`.** When stdin is a pipe feeding the child, the question is still asked on the terminal and the piped data still reaches the child (confirmed). Without any terminal the run is refused, and nothing is written to `trusted.json`.
- **A context line precedes every decryption:** `secenv: <profile>[/keys] (<source>) -> <command>` on stderr. The Touch ID dialog itself (owned by `age-plugin-se`) carries no context, so this line is what the user can check while the dialog is up.
- **`age`, `age-plugin-se` and `age-keygen` are never resolved from `PATH`.** They are looked up in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` (or `SECENV_TOOL_DIRS`), and `age` is spawned with that `PATH` so it finds the plugin the same way. Confirmed: an `npm start` in a repository shipping `node_modules/.bin/age` (first on npm's `PATH`) decrypted through the system binary; the repository's copy was never executed.
- **A `--public-env` file cannot redirect execution.** `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*` and `LD_*` are dropped with a warning naming them; other keys (`PORT`) pass. Confirmed: with a repository `.env.public` that put `<repo>/localbin` first, `aws` no longer resolves to the repository's binary.
- **`run profile/KEY` passes only the listed keys** to the child (confirmed), and with the fixed tool path nothing else sees the rest.
- **`.secenv` content is validated** against the profile-name pattern before it reaches any prompt or message; a multi-line or invalid file is rejected.

### B2: other local processes and users

- Nothing plaintext on disk: profiles are `age` ciphertext, the temporary file during a write holds ciphertext and is created with `wx`, `identity.txt` is a reference to the Secure Enclave key.
- Permissions: `~/.config/secenv` and `profiles/` `0700`, profile files, `identity.txt`, `recipient.txt`, `trusted.json` `0600`. A pre-existing data directory with a wider mode is re-tightened on every start (confirmed: `755` → `700`, including `profiles/`).
- `profile export --out <file>` creates the file itself with mode `0600` and refuses to overwrite (confirmed: `600`, second call fails with "already exists"). The README no longer recommends a shell redirect. Export to a pipe still requires `--allow-pipe`; export to a terminal prints a plaintext warning.
- Secrets never appear in argv or in error messages; `set` uses hidden input, so nothing lands in shell history; `get` refuses a non-TTY stdout without `--allow-pipe`, and both checks run before decryption.
- Secrets in the launched process's environment are visible to that process and its children, and to `ps -E` for the same user. This is the design and is documented.

### B3: network and supply chain

- `update` accepts only a semver version string from the registry (confirmed: `"9.9.9 --ignore-scripts=false"` is rejected), shows the version change and the release notes with escape sequences and control characters stripped (confirmed with a changelog containing CSI and OSC sequences), prints a GitHub compare link, asks for confirmation (or `--yes`), installs that exact version with `npm install -g --ignore-scripts`, and refuses unless `realpath(self)` is under `realpath(npm root -g)`.
- `setup` runs `brew install` only after a confirmation that names the packages, and verifies afterwards that the tools are actually present.
- The trust root remains the npm account (2FA) and Homebrew. See "Open items".

### B4: arguments and inputs

- No shell anywhere; every spawn uses an argv array. Profile names, keys, versions, directory names and file paths cannot inject commands.
- `splitProfileKeys`, `PROFILE_NAME` (now also rejecting `.` and `..`), `checkKey` and `path.join(STORE, name + '.age')`: no traversal (`set ..`, `set ./Y`, `get /K`, `set a/b/K` are rejected).
- `SECENV_HOME` is resolved to an absolute path; `trusted.json` that is not a plain object of string lists is treated as empty (confirmed: `null` → "No approved directories").
- `install.sh` and `uninstall.sh`: `set -euo pipefail`, quoted paths; `uninstall.sh` now refuses to remove a data directory that has neither `identity.txt` nor `profiles/`, and still asks before deleting.

## Open items

### Needs validation (outside the source)

- **Biometry policy.** The key is created with `--access-control=any-biometry`, stricter than the plugin default (`any-biometry-or-passcode`): the login password alone cannot decrypt. It accepts fingerprints enrolled later, which requires the login password and physical access; `current-biometry` would close that but stops working whenever fingerprints change. Whether macOS falls back to the password after repeated failed Touch ID attempts under this policy was not tested on hardware.
- **Touch ID dialog text.** The dialog shows only `age-plugin-se`; whether the calling process or any context can be surfaced in it was not checked. The stderr context line is the mitigation.

### Design limits (documented, not fixable in secenv)

- The directory approval and the context line make a repository's request visible; they do not sandbox the launched code. A command the user approves receives the profile (or the listed keys) and can do anything with it. "Only run commands you trust" remains the rule, and per-project provider keys with spending limits remain the blast-radius control.
- Approving a directory a script can `cd` into (home, `/tmp`) weakens the approval; the README says so.

### Process

- The npm package is unsigned and has no provenance attestation; `npm publish --provenance` from CI would let users verify that a release was built from the tagged commit. Until then, the README's advice to pin an exact version is the control.
- The tagged source and the published tarball should keep matching; the review verified this for 0.2.0 by diff.

## Coverage statement

One source pass plus one independent review; sandbox reproduction only, no real Secure Enclave, no network. Not covered: the internals of `age` and `age-plugin-se`, macOS biometric fallback behaviour, the npm registry's own integrity guarantees, and Tab completion in a live terminal.
