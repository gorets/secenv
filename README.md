# secenv

Personal secrets for local development, without a plaintext `.env` full of API
keys. Secrets are stored encrypted with [age](https://github.com/FiloSottile/age).
The private key lives in the Mac Secure Enclave and cannot be exported, and every
decryption requires Touch ID. Decrypted values exist only in memory and are
passed to the environment of the process you launch. Nothing is written to disk
in plaintext.

Secrets are personal: each person has their own, on their own machine. Nothing
is synced or shared.

## Requirements

- Mac with Apple Silicon and Touch ID (the Secure Enclave is required)
- [Homebrew](https://brew.sh)
- Node.js 22+ for `install.sh` (it copies the CLI as an extensionless ES module;
  Node 20.19 also works, but the script requires 22 to keep the rule simple), or
  Node.js 18+ when installing from npm

## What is the Secure Enclave

The Secure Enclave is a separate security chip inside Apple Silicon Macs (and
iPhones), with its own processor and memory, isolated from the main system. It
stores cryptographic keys and performs operations with them (signing,
decryption):

- A key is generated inside the chip and never leaves it. Neither macOS, nor any
  program, nor you can read its bytes. A program can only ask the chip to
  decrypt something.
- It works with Touch ID: the chip itself verifies the fingerprint and allows
  the operation only afterwards. Applications never see the fingerprint, only
  the yes/no result.

What this means for secenv:

- Profiles in `~/.config/secenv/profiles/` are encrypted, and the key for them
  lives in the Secure Enclave. Copying the directory to another computer is
  useless: it can be decrypted only on this Mac, with your fingerprint.
- Malware that reads your files gets only encrypted data. To decrypt it needs
  you to touch the sensor.
- If the Mac is lost, broken or wiped, the key is gone with the chip. Keep the
  real secret values elsewhere (a password manager) and treat secenv as a working copy.

What it does not protect against: someone who already controls your unlocked
session and touches the sensor themselves, and the process you launch, which
sees the decrypted secrets in its environment.

## Install

```bash
git clone https://github.com/gorets/secenv.git && cd secenv
./install.sh
```

The script installs `age` and `age-plugin-se`, copies `secenv` to
`~/.local/bin`, and creates a key in the Secure Enclave. If `~/.local/bin` is not
on your `PATH`, it tells you what to add to `~/.zshrc`.

If installing `age-plugin-se` through Homebrew fails, install it following the
[plugin's README](https://github.com/remko/age-plugin-se) and run `./install.sh`
again. It is safe to re-run.

### Install via npm (alternative)

```bash
npm i -g @vladimir.gorobets/secenv@0.8.0   # pin the version: this tool sees all your secrets
secenv setup
```

`secenv setup` does the rest and is safe to re-run:

- checks for `age` and `age-plugin-se` and offers to run `brew install` for the
  missing ones (npm cannot install them);
- creates the Secure Enclave key if there is none yet (`secenv init`);
- installs the zsh completion into Homebrew's `site-functions`, or tells you to
  add `source <(secenv completion zsh)` to `~/.zshrc` (after `compinit`).

Or run without installing: `npx @vladimir.gorobets/secenv@0.8.0 run myapp -- node app.js`. `npx`
checks the package on every call, so for daily use a global install (or a
`devDependency` in your project) is faster. Pin a version either way, so that an
update to the package cannot silently change the code that handles your
secrets. Installing from npm works on Node 18+.

To update later:

```bash
secenv update --check   # show the latest version and a link to the changes
secenv update           # confirm, then npm install -g <exact version>
```

`update` never runs silently: it shows the version change, the release notes
from [CHANGELOG.md](CHANGELOG.md) and a GitHub compare link, asks for confirmation (`-y` without a terminal), and
installs that exact version. It also refreshes the zsh completion installed by
`setup`. It works only for a global npm install; with `install.sh`, update with
`git pull && ./install.sh`, and with `npx` or a project dependency, bump the
pinned version yourself.

Use one installation method, not both: `install.sh` puts a copy in
`~/.local/bin`, and if both exist the one earlier in `PATH` wins (check with
`which -a secenv`).

### Shell completion (zsh)

`install.sh` also installs a zsh completion to
`$(brew --prefix)/share/zsh/site-functions/_secenv` (with npm, `secenv setup`
does the same). Open a new terminal to use it. Without Homebrew's directory, add
this to `~/.zshrc` after `compinit`:

```bash
source <(secenv completion zsh)
```
 It completes subcommands and profile names (read from file names, so no Touch
ID prompt), and after `--` it hands off to the wrapped command's own completion,
so `secenv run myapp -- npm run <Tab>` works as usual.

If Tab does nothing, make sure `compinit` runs in your `~/.zshrc` and reset the
cache:

```bash
rm -f ~/.zcompdump* && autoload -U compinit && compinit
```

To save typing, an alias keeps completion working too:
`alias sew='secenv run myapp --'`, then `sew npm run <Tab>`.

### Shorter commands (optional)

Add aliases to `~/.zshrc`. `compdef` keeps Tab completion working for the alias:

```bash
alias se=secenv
compdef se=secenv

# run with the profile from .secenv: sr npm start
alias sr='secenv run --'

# or pin a profile: sew npm start
alias sew='secenv run myapp --'
```

Check that the name is free first (`command -v se`). Any other short name works
the same way, for example `sx` or `senv`. Aliases that end in `--` still complete
the wrapped command, so `sr npm run <Tab>` works as usual.

## Quick start

A profile is the set of secrets one project needs (`myapp`, `myapp-staging`).
Everywhere in the CLI, `myapp` means the whole profile and `myapp/NAME` one
secret in it, the same form the `.env` references use (`secenv://myapp/NAME`).

Verify the setup with a throwaway value before storing real keys:

```bash
secenv set test/FOO                              # type a value, input is hidden
secenv list test                                 # prints names only: FOO
secenv run test -- sh -c 'echo "FOO=$FOO"'       # Touch ID prompt, then FOO=<value>
secenv rm test/FOO
```

Then use it for real:

```bash
# enter secrets (values are typed hidden); the shell expands the braces
secenv set myapp/{OPENAI_API_KEY,STRIPE_SECRET_KEY}

# or import an existing .env: pick the keys, then let secenv replace their
# values in the file with secenv:// references (the file becomes committable)
secenv import myapp

# run a command with the secrets in its environment (Touch ID prompt)
secenv run myapp -- node app.js

# .env in the project is read automatically; values like secenv://myapp/NAME
# are replaced with secrets, everything else is passed as is (see below)
secenv run -- node app.js

# default profile for a project
echo myapp > .secenv
secenv run -- npm start
```

In `package.json`:

```json
"scripts": { "start": "secenv run -- node app.js" }
```

## Commands

Every command answers `--help` (`secenv run --help`, `secenv profile --help`).
Unknown options are an error, so a typo is never taken for a name.

| Command | Description |
| --- | --- |
| `secenv set <profile>/NAME...` | Enter secret values (hidden input); overwrites existing ones |
| `secenv get <profile>/NAME [--allow-pipe]` | Print one secret value. Terminal only (see below) |
| `secenv rm <profile>/NAME...` | Remove secrets; a name that is not there is an error and nothing is removed |
| `secenv cp <profile>/NAME <profile>[/NAME] [-f]` | Copy one secret to another profile, optionally under a new name (one Touch ID per profile); `-f` overwrites |
| `secenv mv <profile>/NAME <profile>[/NAME] [-f]` | Move one secret, or rename it inside a profile |
| `secenv list [<profile>] [--older-than 90d]` | Without a profile: list profiles (no Touch ID). With one: its secret names with the dates they were added and last changed, never values; `--older-than` (`d`, `w`, `m`) keeps only secrets not changed for that long. `ls` is the same command |
| `secenv import <profile>[/NAME...] [-e <file>] [--all] [--rewrite \| --no-rewrite]` | Import variables from a `.env` file (default `./.env`): interactive picker, or only the named ones, then optionally rewrite the values as `secenv://` references |
| `secenv export <profile> [--out <file>] [--allow-pipe]` | Print a profile in `.env` format (terminal only), or write it to a `0600` file |
| `secenv run [<profile> \| <profile>/NAME...] [-e <file> \| --no-env] -- <command...>` | Run a command with secrets in its environment; reads `./.env` by default |
| `secenv profile rm <profile> [-y]` | Delete a profile with all its secrets (asks to confirm) |
| `secenv profile mv <old> <new>` | Rename a profile |
| `secenv profile cp <src> <dst>` | Copy a profile |
| `secenv trust ls [<profile>]` | Directories trusted to use profiles (see "Trusted directories") |
| `secenv trust rm [<dir>]` | Revoke a directory (default: the current one) |
| `secenv trust prune` | Drop entries of directories that no longer exist |
| `secenv setup` | Install `age` + `age-plugin-se`, create the key, set up completion (for npm installs; safe to re-run) |
| `secenv update [--check] [-y]` | Update a global npm install to the latest version (asks to confirm) |
| `secenv completion zsh` | Print the zsh completion script |
| `secenv version` | Print the installed version (also `-v`, `--version`) |

`secenv init` creates only the Secure Enclave key; `install.sh` and `setup` run it for you.

All `<profile>/NAME` items in one command must be in the same profile: one
profile is one decryption, one Touch ID. To name several secrets without
repeating the profile, let the shell expand braces:
`secenv rm myapp/{OLD_KEY,UNUSED_KEY}`.

Profile names may contain only letters, digits, `.`, `-` and `_`; secret names
are environment variable names (letters, digits, `_`, not starting with a digit).

### Managing profiles

`list`, `profile rm`, `profile mv` and `profile cp` work on the encrypted files
directly, so none of them needs Touch ID:

```bash
secenv list                             # myapp, myapp-staging, ...
secenv profile cp myapp myapp-staging   # copy, then change a few secrets with set
secenv profile mv myapp-staging staging # rename
secenv profile rm staging               # asks to confirm; -y without a terminal
```

- `profile cp` and `profile mv` refuse to overwrite an existing profile.
- `profile mv` lists the directories that were trusted with the old name;
  update their `.secenv` files yourself.
- `profile rm` also drops the trust entries for that profile, so a profile
  created later under the same name has to be trusted again.

#### Moving to a new Mac

The Secure Enclave key cannot be moved, so the only way to carry secrets over is
through plaintext. `export` prints a profile in `.env` format (Touch ID).
Like `get`, it writes only to a terminal. To write a file use `--out`, which
creates it with mode `0600` and refuses to overwrite; a shell redirect would use
your umask (usually `0644`, readable by every local account). A pipe needs an
explicit `--allow-pipe`.

```bash
# old Mac
secenv export myapp --out myapp.env
# copy myapp.env over a channel you trust, then on the new Mac
secenv import myapp -e myapp.env --all --no-rewrite && rm myapp.env
```

Delete the file on both machines as soon as it is imported. If your secrets also
live in a password manager, re-entering them with `secenv set` on the new Mac
avoids the plaintext file altogether.

### Importing from `.env`

`secenv import <profile>` reads `./.env` (or the file given with `-e`), shows a
checklist of its variables (space toggles, `a` toggles all, enter confirms) and
stores the selected ones in the profile. Empty values (`NAME=`) and lines that
are already `secenv://` references are skipped. Secrets that already exist in
the profile with a different value are listed before they are overwritten. It
then offers to rewrite the file: the imported values are replaced with
`secenv://<profile>/NAME`, every other line stays as it is, so the file holds no
secrets and can be committed.

```bash
secenv import myai                            # picker, then "replace values? [y/N]"
secenv import myai/OPENAI_API_KEY             # only this one, no picker
secenv import myai --all --rewrite            # no questions (--all is also the non-TTY default)
secenv import myai --no-rewrite               # import, leave the file alone
secenv import myai -e .env.local              # another file
```

Rewriting the file does not wipe the old bytes from the disk, so keys that were
ever stored in plaintext should still be rotated.

### Referencing secrets from `.env`

`run` reads `./.env` in the current directory (or the file given with `-e`/`--env`),
like dotenv. A value of the form `secenv://NAME` or `secenv://<profile>/NAME` is
replaced with that secret from the profile; every other value is passed as it
is. The file therefore contains no secrets and can be committed:

```bash
# .env, committed
OPENAI_API_KEY=secenv://myai/OPENAI_API_KEY
MISTRAL_API_KEY=secenv://myai/MISTRAL_API_KEY
MODEL=gpt-4.1
```

```bash
secenv run -- npm start          # profile myai comes from the references
```

- When the references name a profile, no other profile source is needed.
  `secenv://NAME` without a profile uses the run's profile (argument,
  `SECENV_PROFILE` or `.secenv`).
- References may point at several profiles. It works, but each profile is a
  separate decryption, so every run asks for Touch ID once per profile, and
  secenv prints a warning. Keep one profile per project instead: a profile is
  the set of secrets a project needs, not one per provider.
- When a file contains references, the command receives only the referenced
  secrets (under the names on the left-hand side), not the whole profile. A
  reference to a missing secret is an error.
- `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*` and `LD_*` in the file are
  ignored with a warning: the file may come from the repository, and it must not
  decide which binary runs or what gets loaded into it.
- `--no-env` skips the file. Drop `--env-file=.env` from your `node` scripts:
  Node would fail on a file it cannot find, and the variables are already in the
  environment.

### Passing only some secrets

By default `run` passes the whole profile. List `<profile>/NAME` items instead
to give the command only those secrets (all items must use the same profile):

```bash
secenv run myapp/OPENAI_API_KEY -- node script.js
secenv run myapp/{OPENAI_API_KEY,STRIPE_SECRET_KEY} -- node app.js
```

A name missing from the profile is an error, so a typo does not silently start
the command without the secret.

### Choosing a profile

`secenv run` picks the profile in this order:

1. the argument: `secenv run myapp -- ...`
2. the `SECENV_PROFILE` environment variable
3. the `.secenv` file in the current directory (one line, the profile name)

Whatever the source, the first use of that profile in the current directory
asks whether to trust the directory with it (see "Trusted directories").

### Variable precedence

When the same name appears in several places, the later one wins:

1. your current shell environment
2. the env file (`./.env` or `-e <file>`), references resolved
3. the secret profile

`PATH`, `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*` and `LD_*` in the env file are
ignored with a warning.

### Trusted directories

The code you launch decides nothing; the directory you launch it from does. The
first time `secenv run` uses a profile in a directory, however the profile was
named (argument, `SECENV_PROFILE` or `.secenv`), it asks on your terminal:

```
secenv: first use of profile "myapp" (argument) in /path/to/project
  command: node app.js
Trust this directory to use "myapp" from now on? [y/N]
```

This matters because a cloned repository can put `secenv run myapp -- …`
into its `package.json` just as easily as a profile name into `.secenv`, and the
Touch ID dialog shows neither the profile nor the command. Read the two lines
before answering: if you did not expect that profile or that command in that
directory, answer `n`. Before every decryption `run` also prints one line,
`secenv: <profile> (<source>) -> <command>`, which is what you can check while
the Touch ID dialog is up.

Trust is stored per directory in `~/.config/secenv/trusted.json` (realpath of
the directory → list of profiles). The question is asked on `/dev/tty`, so it
works even when stdin is a pipe feeding the command; without any terminal (CI)
a run in an untrusted directory is refused. Trusting your home directory or
`/tmp` is a bad idea: a script can `cd` there.

To view or revoke trust (no Touch ID):

```bash
secenv trust ls            # every trusted directory and its profiles
secenv trust ls myapp      # only directories that may use myapp
secenv trust rm            # revoke the current directory (or pass a path)
secenv trust prune         # drop entries of deleted directories
```

Revoke trust when you answered `y` too quickly, when the code in that folder is
no longer something you trust (for example a different repository was cloned
into the same path), or when the project is gone. `profile rm` revokes the
trust entries of the deleted profile by itself.

### Piping values

A single value can be piped, including multi-line values such as private keys:

```bash
cat key.pem | secenv set myapp/PRIVATE_KEY
```

Several values can be piped, one line per secret:

```bash
printf 'value1\nvalue2\n' | secenv set myapp/{KEY1,KEY2}
```

## Files

Everything lives in `~/.config/secenv/` (override with `SECENV_HOME`):

| File | Purpose |
| --- | --- |
| `identity.txt` | Reference to the key in the Secure Enclave (not the key itself) |
| `recipient.txt` | Public key used for encryption |
| `profiles/*.age` | Encrypted secret sets, one per profile |
| `trusted.json` | Directories trusted to use profiles |

The zsh completion is installed separately, outside this directory (see above).

A profile file is a JSON object encrypted with `age`; each secret carries the
dates it was added and last changed:
`{"OPENAI_API_KEY": {"value": "...", "added": "2026-10-18T14:02:11Z", "updated": "2026-10-18T14:02:11Z"}}`.
The dates are inside the ciphertext, like the key names. The private key exists only inside the Secure Enclave and never leaves it,
so a copy of this directory on another machine cannot be decrypted.

Do not send these files to anyone: profiles can be decrypted only by the key in
your Mac's Secure Enclave. To give a colleague a secret, use your password
manager, not secenv.

### Viewing secrets

```bash
secenv list                          # profile names, no Touch ID
secenv list myapp                    # secret names and dates, never values (Touch ID)
secenv list myapp --older-than 90d   # secrets not rotated for 90 days
secenv get myapp/OPENAI_API_KEY      # the value (Touch ID)

# check a value without printing it
secenv run myapp -- sh -c 'echo "${#OPENAI_API_KEY} chars"'
```

The printed value stays in your terminal scrollback, so prefer the length check
for real keys.

#### Why `get` refuses to write into a pipe

`secenv get` prints only to a terminal. In a pipe or in `$(...)` it exits with an
error:

```bash
node index.js --key $(secenv get myapp/OPENAI_API_KEY)    # refused
```

A secret passed as a command-line argument is visible to every process of your
user through `ps`, and it often ends up in logs and crash reports. A variable in
the process environment does not leak like that. If the program only accepts the
key as an argument, let the child shell expand it, which still goes through
`run`:

```bash
secenv run myapp -- sh -c 'node index.js --key "$OPENAI_API_KEY"'
```

Better still, make the program read `process.env.OPENAI_API_KEY` and drop the
flag. If you accept the risk, `secenv get myapp/NAME --allow-pipe` prints the raw
value without a trailing newline.

Quote the command so the child process, not your shell, expands the variable.
`secenv run myapp -- echo $OPENAI_API_KEY` prints an empty line, because your
shell substitutes `$OPENAI_API_KEY` (unset there) before secenv starts.

To decrypt a profile by hand, which is what secenv does internally (Touch ID,
prints every value in plaintext):

```bash
age -d -i ~/.config/secenv/identity.txt ~/.config/secenv/profiles/myapp.age
```

Secret values never end up in shell history, because `set` takes them through
hidden input rather than as arguments. While the launched process runs, it and
its children can read the secrets from their environment (for example with `env`).

## Important

- **Losing the Mac means losing the key.** A Secure Enclave key cannot be
  backed up or restored, and encrypted profiles become unreadable without it.
  Keep the real secret values in your primary store (a password manager) and treat secenv as
  a working copy.
- Touch ID is requested on every `secenv run`, `get` and `export` (and on
  `set`, `import`, `list <profile>`, `rm`, `cp` and `mv` for an existing
  profile).
- Re-running `secenv init` after deleting `identity.txt` creates a new key and
  **old profiles can no longer be decrypted.**
- A secret passed to a child process is visible to that process and everything
  it spawns. Limit the blast radius at the provider: a separate key per project
  with a spending limit.
- secenv does not protect against someone who already controls your session and
  approves Touch ID themselves. It only prevents reading secrets without your
  fingerprint, and keeps them out of plaintext files and shell history.
- Only run `secenv run` with commands you trust. The launched code receives the
  secrets. The directory trust prompt and the `secenv: <profile> -> <command>` line
  exist so that you notice when a repository's script asks for a profile you did
  not expect; they are not a sandbox.
- `age` and `age-plugin-se` are run from fixed system directories
  (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`), never from
  `PATH`, so a repository cannot substitute them through `node_modules/.bin`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `secenv: command not found` | Add `~/.local/bin` to `PATH` |
| `key not created. Run: secenv init` | Run `secenv init` |
| `"age" not found in /opt/homebrew/bin, /usr/local/bin, …` | secenv looks for `age` and `age-plugin-se` only in those directories, never in `PATH`; `brew install age age-plugin-se`, or set `SECENV_TOOL_DIRS` if they live elsewhere |
| `could not decrypt (Touch ID cancelled or key does not match)` | Retry and approve Touch ID; if the key was recreated, the old profile is unrecoverable, so delete it and re-enter the secrets |
| `profile "<name>" not found` | Create it with `secenv set <name>/NAME` |
| `profile "…" (…) is not trusted in … and there is no terminal to ask` | Run it once from a terminal and answer `y` (trust is per directory) |
| `expected <profile>/NAME, got "myapp"` | Secrets are addressed as `myapp/NAME`; a bare `myapp` means the whole profile |
| `all secrets in one command must be in one profile` | Split the command, one profile each |
| `invalid profile name in .../.secenv` | The file must contain one line with a profile name (letters, digits, `.`, `-`, `_`) |
| `refusing to print a secret into a pipe or $(...)` | Use `secenv run <profile> -- sh -c '...'` so the child shell expands the variable, or add `--allow-pipe` if you accept the `ps` exposure |
| `--env requires a value` | Pass the file: `-e .env.public` |
| `SyntaxError` / "To load an ES module" when running `secenv` | Node is older than 22 (20.19+ also works); upgrade Node |
| Node reports `<file>: not found` for `--env-file` | The secenv flag is `--env`; Node intercepts `--env-file` itself. Inside your own `node` scripts, drop `--env-file=.env`: secenv already loaded it |
| A command killed by a signal | `secenv run` exits with `128 + signal number` (for example 143 for SIGTERM), like a shell would |

## For AI coding agents

[`.agents/skills/secenv/SKILL.md`](.agents/skills/secenv/SKILL.md) teaches coding agents how to work in a project that uses secenv: run commands through `secenv run`, batch Touch ID prompts, leave storing secrets and trusting directories to the human, and never print values. Copy it into a project's `.agents/skills/` (or your agent's skills directory) to use it there.

## Uninstall

Installed from npm:

```bash
npm uninstall -g @vladimir.gorobets/secenv
rm -f "$(brew --prefix)/share/zsh/site-functions/_secenv"   # if setup installed it
rm -r ~/.config/secenv      # optional: deletes all encrypted profiles for good
```

Installed with `install.sh`:

```bash
./uninstall.sh              # asks before deleting your encrypted profiles
./uninstall.sh --keep-data  # remove only the CLI and completion
./uninstall.sh --purge      # remove everything without asking
```

It removes `~/.local/bin/secenv`, the zsh completion and, if you confirm,
`~/.config/secenv` (all encrypted profiles and the key reference; they cannot be
decrypted afterwards). `age` and `age-plugin-se` are left installed; remove them
with `brew uninstall age-plugin-se age` if you no longer need them.

## Testing without a Secure Enclave

For tests or machines without a Secure Enclave only, `secenv init` can create a
plain software key:

```bash
SECENV_INSECURE_SOFTWARE_KEY=1 secenv init
```

The key is then stored unprotected on disk and no Touch ID is required. Never use
this for real secrets.
