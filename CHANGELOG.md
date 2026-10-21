# Changelog

All notable changes to secenv. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.9.2] - 2026-10-21

### Fixed

- `secenv update` failed with `ETARGET` for a few minutes after a release,
  because npm resolved the version from its cached metadata. It now passes
  `--prefer-online` to npm.

## [0.9.1] - 2026-10-21

### Changed

- Releases are published to npm by GitHub Actions, with provenance, when the
  version in `package.json` changes on `main`.

## [0.9.0] - 2026-10-21

### Security

Fixes from the 2026-10-21 security review:

- The trust prompt and the `secenv: <profile> -> <command>` line showed the
  command's arguments raw. A `package.json` script could include terminal
  control bytes (`\u001b[2K\r`) in an argument, so the terminal cleared the
  real command and displayed `node app.js` instead; the Touch ID dialog shows
  no context of its own. Control characters and invisible Unicode are now
  printed visibly (`\e`, `\r`, `\u202e`) and arguments holding whitespace,
  quotes or such characters are quoted. The env file name in messages gets the
  same treatment.
- The plain variables an env file sets are now part of the directory trust:
  the prompt lists them, `trusted.json` stores them per profile, and `run`
  asks again, naming the new variables, when the file starts setting one it
  did not set before (`trust ls` shows them). The file comes from the
  repository too, and `BASH_ENV`, `ZDOTDIR`, `AWS_CONFIG_FILE` or an
  `HTTPS_PROXY` change what the approved command loads or talks to. Those and
  similar variables (`HOME`, `SHELL`, `NODE_EXTRA_CA_CERTS`, `PYTHONPATH`,
  `PERL5OPT`, `GIT_*`, `DOCKER_CONFIG`, `*_PROXY`, …) are also refused
  outright, in addition to `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*`,
  `LD_*`.
- Plain env-file values no longer override variables already set in the shell
  (dotenv semantics); secrets still do.
- A closed terminal (or ctrl-D) at a `[y/N]` question now means "no" and exits
  with "cancelled" instead of leaving the process hanging on an unsettled
  promise.

### Changed

- `trusted.json` format: directory → profile → list of env-file variables.
  Files from 0.4–0.8 are read; a directory trusted before is asked once more
  if its env file sets plain variables, otherwise upgraded silently.
- Precedence: env file (plain) < shell < profile. Previously the file beat the
  shell.

### Added

- `secenv skill install [<dir>] [-f]`: copies the skill for AI coding agents to
  `<dir>/secenv/SKILL.md` (default `~/.claude/skills`). The skill is now
  shipped in the npm package.
- `npm test`: unit tests for the display helpers and `trusted.json` parsing.

### Fixed

- The `claude:skill:install` entry added to `bin` in the previous commit was
  not a file path, so npm dropped it silently, and `.agents/` was not in the
  package at all.

## [0.8.2] - 2026-10-19

### Added

- `secenv export <profile> --out <file>` with an existing file fills it in
  instead of refusing: `secenv://<profile>/NAME` and bare `secenv://NAME`
  references become the values, secrets the file neither sets nor references
  are appended, every other line stays. The file is set to mode `0600`.

### Fixed

- `export` wrote every value in double quotes with `\"` escapes. Node's
  `--env-file` cut such a value at the escaped quote, and Docker Compose
  expanded `$VAR` inside it. Values are now written unquoted when they hold
  only `A-Za-z0-9-_.:/+=@,%~`, otherwise in single quotes, which every common
  reader takes literally. A value with a single quote stays unquoted unless it
  also holds `#`, `$`, a line break or edge spaces; only then double quotes,
  and export names such a value if it also holds `"`, `\` or `$`. Checked
  against secenv, Node `--env-file`, Docker Compose and python-dotenv.

## [0.8.1] - 2026-10-19

### Added

- `secenv list <profile>` shows a masked preview of each value to tell tokens
  apart: the start and the last 4 characters, as provider consoles show keys
  (`sk-ant-api03-cxx****cQAA`). At most a third of a value is revealed and at
  least 16 characters stay hidden; values under 24 characters and multi-line
  values show only their size. Computed at listing time, not stored; a pipe
  still gets names only.

## [0.8.0] - 2026-10-19

A cleanup of the command line: one form per action, one way to address a
secret. Old forms are removed, not aliased.

### Changed

- A secret is addressed as `<profile>/NAME` everywhere, a bare `<profile>`
  means the whole profile: `set`, `get`, `rm`, `cp`, `mv`, `import` and `run`.
  `secenv set myapp KEY1 KEY2` becomes `secenv set myapp/KEY1 myapp/KEY2`, or
  `secenv set myapp/{KEY1,KEY2}` with the shell expanding the braces. All items
  of one command must be in one profile.
- `export` and `trust` are top-level commands: `secenv export <profile>`,
  `secenv trust ls|rm|prune` (was `secenv profile export`, `secenv profile
  trust …`). `trust rm` without a directory revokes the current one. `profile`
  keeps only `rm`, `mv` and `cp`.
- Profiles are listed only by `secenv list` (or `ls`); `secenv profiles`,
  `profile ls|list`, `profile <name>` and `trust list` are gone.
- `import`: the file is given with `-e/--env <file>` (as in `run`) instead of
  a second positional; `--only K,K` is replaced by `<profile>/NAME` items;
  `--keep` is renamed `--no-rewrite`. Secrets that would be overwritten with a
  different value are listed first.
- `run`: several secrets are `<profile>/NAME` items as before; `-e` is short for
  `--env`; the undocumented `--public-env` is removed.
- `list --older 90d` is `list --older-than 90d` and also takes weeks and months
  (`12w`, `6m`).
- Short options: `-y` for `--yes` (`profile rm`, `update`), `-f/--force` for
  `cp`/`mv`.
- Wording: "trust" everywhere instead of "approval" ("is not trusted in …",
  "Trust this directory to use …?"). `NAME` instead of `KEY` for a secret name,
  so it is not confused with the Secure Enclave key.
- `secenv --help` explains what a profile is and leaves `init` to `setup`.

### Added

- `cp`/`mv -f` overwrite an existing secret (they still refuse by default).
- `.agents/skills/secenv/SKILL.md`: a skill for AI coding agents working in a
  project that uses secenv.

### Fixed

- `rm` with a name that is not in the profile was reported as removed. It is
  now an error and nothing is removed.
- Unknown options are rejected instead of being taken for names.

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

[0.9.2]: https://github.com/gorets/secenv/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/gorets/secenv/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/gorets/secenv/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/gorets/secenv/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/gorets/secenv/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/gorets/secenv/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/gorets/secenv/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/gorets/secenv/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/gorets/secenv/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/gorets/secenv/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/gorets/secenv/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gorets/secenv/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/gorets/secenv/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/gorets/secenv/tree/v0.2.0
[0.1.0]: https://www.npmjs.com/package/@vladimir.gorobets/secenv/v/0.1.0
