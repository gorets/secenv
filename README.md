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
- Node.js 22+ (the CLI is installed as an extensionless ES module; Node 20.19
  also works, but `install.sh` requires 22 to keep the rule simple)

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
  real secret values elsewhere (Keeper) and treat secenv as a working copy.

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

### Shell completion (zsh)

`install.sh` also installs a zsh completion to
`$(brew --prefix)/share/zsh/site-functions/_secenv`. Open a new terminal to use
it. It completes subcommands and profile names (read from file names, so no Touch
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

Verify the setup with a throwaway value before storing real keys:

```bash
secenv set test FOO                              # type a value, input is hidden
secenv list test                                 # prints names only: FOO
secenv run test -- sh -c 'echo "FOO=$FOO"'       # Touch ID prompt, then FOO=<value>
secenv rm test FOO
```

Then use it for real:

```bash
# enter secrets (values are typed hidden)
secenv set wildix_dev OPENAI_API_KEY STRIPE_SECRET_KEY

# or import an existing .env, then delete it
# (deleting does not wipe data on APFS/SSD, so treat keys that were ever in a
# plaintext .env as exposed and rotate them)
secenv import wildix_dev .env && rm .env

# run a command with the secrets in its environment (Touch ID prompt)
secenv run wildix_dev -- node app.js

# also load non-secret variables from a file
secenv run wildix_dev --public-env .env.public -- node app.js

# default profile for a project
echo wildix_dev > .secenv
secenv run -- npm start
```

In `package.json`:

```json
"scripts": { "start": "secenv run -- node app.js" }
```

## Commands

| Command | Description |
| --- | --- |
| `secenv init` | Create the Secure Enclave key (once; `install.sh` does this) |
| `secenv set <profile> KEY [KEY...]` | Enter secret values (hidden input); updates existing keys |
| `secenv import <profile> <file>` | Import a `.env` file, merging into the profile |
| `secenv list <profile>` | Print secret names (never values) |
| `secenv get <profile> KEY` | Print one secret value; also accepts `<profile>/KEY`. Terminal only (see below) |
| `secenv rm <profile> KEY [KEY...]` | Remove secrets from a profile |
| `secenv run [<profile>] [--public-env <file>] -- <command...>` | Run a command with secrets in its environment |

A profile is a named set of secrets (for example `wildix_dev`). Profile names
may contain only letters, digits, `.`, `-` and `_`.

### Choosing a profile

`secenv run` picks the profile in this order:

1. the argument: `secenv run wildix_dev -- ...`
2. the `SECENV_PROFILE` environment variable
3. the `.secenv` file in the current directory (one line, the profile name)

### Variable precedence

When the same name appears in several places, the later one wins:

1. your current shell environment
2. `--public-env` file (non-secret variables such as `NODE_ENV` or `PORT`)
3. the secret profile

### The `.secenv` file and trust

A `.secenv` file decides which secrets the launched code receives, so a cloned
repository must not be able to choose that silently. The first time `secenv run`
uses a `.secenv` in a directory, it asks:

```
Project /path/to/project requests profile "wildix_dev". Allow? [y/N]
```

The answer is remembered in `~/.config/secenv/trusted.json`. If `.secenv`
changes (for example after `git pull`), it asks again. Without a terminal (CI,
pipes) such a run is refused; pass the profile as an argument instead. If you are
asked in a repository you do not know, answer `n`.

### Piping values

A single value can be piped, including multi-line values such as private keys:

```bash
cat key.pem | secenv set myapp PRIVATE_KEY
```

Several values can be piped, one line per key:

```bash
printf 'value1\nvalue2\n' | secenv set myapp KEY1 KEY2
```

## Files

Everything lives in `~/.config/secenv/` (override with `SECENV_HOME`):

| File | Purpose |
| --- | --- |
| `identity.txt` | Reference to the key in the Secure Enclave (not the key itself) |
| `recipient.txt` | Public key used for encryption |
| `profiles/*.age` | Encrypted secret sets, one per profile |
| `trusted.json` | Projects whose `.secenv` you approved |

The zsh completion is installed separately, outside this directory (see above).

A profile file is a JSON object (`{"OPENAI_API_KEY": "..."}`) encrypted with
`age`. The private key exists only inside the Secure Enclave and never leaves it,
so a copy of this directory on another machine cannot be decrypted.

Do not send these files to anyone: profiles can be decrypted only by the key in
your Mac's Secure Enclave. To give a colleague a secret, use your password
manager, not secenv.

### Viewing secrets

```bash
ls ~/.config/secenv/profiles       # profile names, no Touch ID
secenv list myapp                  # secret names, never values (Touch ID)
secenv get myapp OPENAI_API_KEY    # the value (Touch ID); same as myapp/OPENAI_API_KEY

# check a value without printing it
secenv run myapp -- sh -c 'echo "${#OPENAI_API_KEY} chars"'
```

The printed value stays in your terminal scrollback, so prefer the length check
for real keys.

#### Why `get` refuses to write into a pipe

`secenv get` prints only to a terminal. In a pipe or in `$(...)` it exits with an
error:

```bash
node index.js --key $(secenv get myapp OPENAI_API_KEY)    # refused
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
flag. If you accept the risk, `secenv get --allow-pipe myapp KEY` prints the raw
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
  Keep the real secret values in your primary store (Keeper) and treat secenv as
  a working copy.
- Touch ID is requested on every `secenv run` and `get` (and on `set`,
  `import`, `list` and `rm` for an existing profile).
- Re-running `secenv init` after deleting `identity.txt` creates a new key and
  **old profiles can no longer be decrypted.**
- A secret passed to a child process is visible to that process and everything
  it spawns. Limit the blast radius at the provider: a separate key per project
  with a spending limit.
- secenv does not protect against someone who already controls your session and
  approves Touch ID themselves. It only prevents reading secrets without your
  fingerprint, and keeps them out of plaintext files and shell history.
- Only run `secenv run` with commands you trust. The launched code receives the
  secrets.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `secenv: command not found` | Add `~/.local/bin` to `PATH` |
| `key not created. Run: secenv init` | Run `secenv init` |
| `could not decrypt (Touch ID cancelled or key does not match)` | Retry and approve Touch ID; if the key was recreated, the old profile is unrecoverable, so delete it and re-enter the secrets |
| `profile "<name>" not found` | Create it with `secenv set <name> KEY` |
| `.secenv ... is not confirmed` (no terminal) | Run once interactively, or pass the profile as an argument |
| `invalid profile name in .../.secenv` | The file must contain one line with a profile name (letters, digits, `.`, `-`, `_`) |
| `refusing to print a secret into a pipe or $(...)` | Use `secenv run <profile> -- sh -c '...'` so the child shell expands the variable, or add `--allow-pipe` if you accept the `ps` exposure |
| `--public-env requires a file` | Pass the file: `--public-env .env.public` |
| `SyntaxError` / "To load an ES module" when running `secenv` | Node is older than 22 (20.19+ also works); upgrade Node |
| Node reports `<file>: not found` for `--env-file` | The flag is called `--public-env`; Node intercepts `--env-file` itself |
| A command killed by a signal | `secenv run` exits with `128 + signal number` (for example 143 for SIGTERM), like a shell would |

## Uninstall

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
