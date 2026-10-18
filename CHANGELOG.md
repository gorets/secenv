# Changelog

All notable changes to secenv. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `.agents/skills/secenv/SKILL.md`: a skill for AI coding agents working in a
  project that uses secenv.

## [0.7.0] - 2026-10-18

### Added

- Every secret stores the dates it was added and last changed, inside the
  encrypted profile. `set` and `import` set `added` once and `updated` when the
  value actually changes; `cp`/`mv` keep the dates.
- `secenv ls <profile>` shows those dates; `--older 90d` lists only secrets not
  changed for that many days. In a pipe `ls` still prints names only.

### Changed

- Profile format: each key maps to `{ value, added, updated }` instead of a
  plain string. Profiles from earlier versions still open; their keys show no
  date until the next change.

## [0.6.2] - 2026-10-18

### Added

- `secenv cp <profile>/KEY <profile>[/KEY]` and `secenv mv …`: copy or move
  one secret between profiles, or rename it inside one. Existing keys are not
  overwritten.

## [0.6.1] - 2026-10-18

### Changed

- `run` accepts `.env` references to several profiles (each one is a separate
  decryption and Touch ID prompt; a warning says so and recommends one profile
  per project). Approvals are collected before the first decryption.
- `ls` and `list` are interchangeable everywhere: `secenv ls`, `secenv list
  <profile>`, `secenv profile list`, `secenv profile trust list`. `secenv ls`
  without a profile lists the profiles; `secenv profile <name>` and
  `secenv profile <name> ls` list the secrets of that profile.
- `import` skips empty values (`KEY=`): they are placeholders, and stored they
  would only make the variable look set. They are listed as skipped and are
  not offered in the picker; `--only` on one of them is an error.

## [0.6.0] - 2026-10-18

### Added

- `run` reads `./.env` (or `--env <file>`) like dotenv. Values of the form
  `secenv://NAME` or `secenv://<profile>/NAME` are replaced with the secret, so
  the file holds no secrets and can be committed. With references the command
  receives only the referenced secrets; the profile can come from the
  references alone. `--no-env` skips the file. `--public-env` remains as an
  alias of `--env`.
- `secenv <command> --help` and `secenv help <command>` print a description,
  options and examples for every command; usage errors name what is missing
  and show the one-line usage. `secenv run app -- tool --help` still passes
  `--help` to the tool.
- `import` shows an interactive checklist of the file's variables (`--all`,
  `--only KEY,KEY` to skip it) and then offers to rewrite the imported values
  in the file as `secenv://<profile>/KEY` references (`--rewrite`, `--keep`),
  keeping comments and order. Lines that already hold references are skipped.
  The file defaults to `./.env`.

## [0.5.0] - 2026-10-18

### Security

Fixes from the 2026-10-18 security audit (`reviews/`):

- `run` asks for approval the first time a profile is used in a directory,
  whatever named the profile (argument, `SECENV_PROFILE` or `.secenv`), and
  prints `secenv: <profile> (<source>) -> <command>` before every decryption.
  Previously only `.secenv` was gated, so a repository's `package.json` script
  could name any profile directly. The question is asked on `/dev/tty`, so it
  works with piped stdin. `trusted.json` now stores a list of profiles per
  directory; the old single-profile format is still read.
- `age`, `age-plugin-se` and `age-keygen` are resolved from fixed system
  directories, never from `PATH`, and `age` runs with that `PATH`. Under
  `npm run` the repository's `node_modules/.bin` is first on `PATH` and could
  supply a fake `age` that sees the whole profile. `SECENV_TOOL_DIRS` overrides
  the list.
- `--public-env` ignores `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*` and
  `LD_*` with a warning; a repository-supplied file could otherwise choose which
  binary receives the secrets.
- `profile export --out <file>` writes the file itself with mode `0600`; a shell
  redirect used the umask and left the plaintext world-readable.
- `update` strips terminal escape sequences from fetched release notes, accepts
  only a semver version from the registry, and passes `--ignore-scripts` to npm.
- Profile names `.` and `..` are rejected; the data directory is re-tightened to
  `0700` on every start; `trusted.json` with an unexpected shape is treated as
  empty; the temporary file in `profiles/` is created with `wx`;
  `SECENV_HOME` is resolved to an absolute path.

### Added

- `secenv update`: checks the latest version on npm, shows the release notes
  and a GitHub compare link, asks for confirmation (`--yes` without a terminal)
  and installs that exact version. `--check` only reports. Works for global npm
  installs; refreshes the zsh completion installed by `setup`.
- `secenv --version` (also `-v`, `version`).
- This changelog, shipped in the npm package.

## [0.4.0] - 2026-10-18

### Added

- `secenv setup`: checks `age` and `age-plugin-se` and offers `brew install`
  for missing ones, creates the Secure Enclave key, installs the zsh
  completion. Safe to re-run.
- `secenv completion zsh`: prints the completion script. The script works both
  autoloaded from `fpath` and sourced after `compinit`.

### Fixed

- `init` fails cleanly when key generation exits successfully without writing
  the identity file.

## [0.3.0] - 2026-10-18

### Added

- `secenv profile ls|rm|mv|cp`: manage profiles as files, no Touch ID needed.
  `cp` and `mv` never overwrite; `mv` lists projects whose `.secenv` still names
  the old profile; `rm` asks to confirm (`--yes` without a terminal).
- `secenv profile export`: prints a profile in `.env` format, terminal only
  unless `--allow-pipe`, for moving secrets to a new Mac.
- `secenv profile trust ls|rm|prune`: view and revoke `.secenv` approvals.

### Changed

- `profile rm` also revokes the `.secenv` approvals of the deleted profile.
- `list` without a profile points to `profile ls`.

### Fixed

- `.env` parsing unescapes in a single pass, so a literal backslash followed by
  `n` survives `export` → `import`.

## [0.2.0] - 2026-10-18

### Added

- `set`, `get` and `rm` accept `<profile>/KEY`.
- `run` accepts one or more `<profile>/KEY` items and passes only those
  secrets to the command.
- npm package `@vladimir.gorobets/secenv`.

## [0.1.0] - 2026-10-18

First published version.

### Added

- Secrets encrypted with `age` to a Secure Enclave key; every decryption
  requires Touch ID.
- Commands `init`, `set`, `import`, `list`, `get`, `rm`, `run`.
- `get` refuses to print into a pipe or `$(...)` unless `--allow-pipe`.
- Project default profile via `.secenv`, used only after explicit approval.
- `--public-env` for non-secret variables.
- zsh completion, `install.sh` and `uninstall.sh`.

[0.7.0]: https://github.com/gorets/secenv/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/gorets/secenv/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/gorets/secenv/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/gorets/secenv/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/gorets/secenv/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gorets/secenv/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/gorets/secenv/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/gorets/secenv/tree/v0.2.0
[0.1.0]: https://www.npmjs.com/package/@vladimir.gorobets/secenv/v/0.1.0
