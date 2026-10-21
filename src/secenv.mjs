#!/usr/bin/env node
// secenv — personal secrets for local dev, encrypted with age.
// The private key lives in the Mac Secure Enclave (age-plugin-se), every
// decryption requires Touch ID. Secrets are decrypted into memory only and
// passed to the child process via its environment. No plaintext on disk.
//
// Requires: Node 22+ (installed without the .mjs extension, so ESM detection
// for extensionless files is needed), `age`, `age-plugin-se` (both on PATH).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(process.env.SECENV_HOME || path.join(os.homedir(), '.config', 'secenv'));
const IDENTITY = path.join(HOME, 'identity.txt');
const RECIPIENT = path.join(HOME, 'recipient.txt');
const STORE = path.join(HOME, 'profiles');
const TRUSTED = path.join(HOME, 'trusted.json');
// Present in the npm package and the repository; install.sh copies only this
// script and installs the completion itself.
const COMPLETION_FILE = fileURLToPath(new URL('./completions/_secenv', import.meta.url));
const PACKAGE_FILE = fileURLToPath(new URL('../package.json', import.meta.url));
const SKILL_FILE = fileURLToPath(new URL('../.agents/skills/secenv/SKILL.md', import.meta.url));
const REGISTRY = (process.env.SECENV_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');

const USAGE = `secenv — personal secrets encrypted with a Secure Enclave key (Touch ID)

A profile is the set of secrets one project needs: myapp, myapp-staging.
myapp means the whole profile, myapp/NAME one secret in it.

usage: secenv <command> [options]
       secenv <command> --help

Secrets
  set <profile>/NAME...              enter values (hidden input); overwrites
  get <profile>/NAME                 print one value (terminal only)
  rm <profile>/NAME...               remove secrets
  cp <profile>/NAME <profile>[/NAME] [-f]
                                     copy one secret (or copy under a new name)
  mv <profile>/NAME <profile>[/NAME] [-f]
                                     move or rename one secret
  list [<profile>] [--older-than 90d]
                                     profiles, or one profile's secrets, masked (ls)

Import / export
  import <profile>[/NAME...] [-e <file>]
                                     .env -> profile, then replace values with secenv:// refs
  export <profile> [--out <file>]    profile -> .env format, e.g. for a new Mac

Run
  run [<profile> | <profile>/NAME...] [-e <file> | --no-env] -- <command...>
                                     run a command with secrets in its environment

Profiles
  profile rm <profile> [-y]          delete a profile and all its secrets
  profile mv <old> <new>             rename
  profile cp <src> <dst>             copy

Trust (which directories may use which profiles)
  trust ls [<profile>]               list trusted directories
  trust rm [<dir>]                   revoke a directory (default: current)
  trust prune                        drop entries of deleted directories

Setup
  setup                              install age + plugin, create the key, completion
  update [--check] [-y]              update a global npm install (asks to confirm)
  completion zsh                     print the zsh completion script
  skill install [<dir>] [-f]         install the skill for AI coding agents (~/.claude/skills)
  version                            print the installed version

Several secrets of one profile: secenv set myapp/{OPENAI_API_KEY,STRIPE_KEY}
Every decryption asks for Touch ID.
`;

const HELP = {
  setup: `usage: secenv setup

Prepares a machine after \`npm i -g\`:
  - checks for age and age-plugin-se in the system directories and offers to
    run \`brew install\` for the missing ones
  - creates the Secure Enclave key if there is none (\`secenv init\` does only
    this step; install.sh calls it)
  - installs the zsh completion into Homebrew's site-functions, or tells you
    what to add to ~/.zshrc

Safe to run again: every step skips what is already in place.`,

  init: `usage: secenv init

Creates the private key in the Secure Enclave (Touch ID required for every
use) and writes its public part to ~/.config/secenv/recipient.txt. Does
nothing if a key already exists. The key cannot be exported or backed up:
losing the Mac means losing the key. \`secenv setup\` runs this for you.

SECENV_INSECURE_SOFTWARE_KEY=1  create a plain file key instead (tests only).`,

  completion: `usage: secenv completion zsh

Prints the zsh completion script. Add to ~/.zshrc after compinit:
  source <(secenv completion zsh)
\`secenv setup\` and install.sh install it into Homebrew's site-functions
instead, which needs no change to ~/.zshrc.`,

  update: `usage: secenv update [--check] [-y]

Checks the latest version on npm, shows the release notes and a compare link,
asks for confirmation and installs that exact version with
\`npm install -g --ignore-scripts\`. Works only for a global npm install.

  --check      only report; install nothing
  -y, --yes    do not ask (for scripts)`,

  skill: `usage: secenv skill install [<dir>] [-f]

Copies the secenv skill for AI coding agents (.agents/skills/secenv/SKILL.md
in the package) to <dir>/secenv/SKILL.md. Default <dir>: ~/.claude/skills.
The skill teaches an agent to run commands through \`secenv run\`, batch
Touch ID prompts, and leave secrets and trust decisions to you.

  -f, --force   overwrite an existing SKILL.md

  secenv skill install                   # ~/.claude/skills/secenv/SKILL.md
  secenv skill install .agents/skills    # into the current project`,

  version: `usage: secenv version   (also -v, --version)

Prints the installed version, or "unknown" for an install.sh copy.`,

  set: `usage: secenv set <profile>/NAME [<profile>/NAME...]

Stores secret values in a profile; the profile is created if needed. Values are
typed hidden (nothing lands in shell history). Existing secrets are
overwritten. All names must be in one profile.

  secenv set myapp/OPENAI_API_KEY
  secenv set myapp/{OPENAI_API_KEY,STRIPE_KEY}     # the shell expands the braces

Values can also be piped: one secret takes the whole input (multi-line is
fine), several take one line each:
  cat key.pem | secenv set myapp/PRIVATE_KEY
  printf 'a\\nb\\n' | secenv set myapp/{KEY1,KEY2}`,

  import: `usage: secenv import <profile> [-e <file>] [--all] [--rewrite | --no-rewrite]
       secenv import <profile>/NAME [<profile>/NAME...] [-e <file>] [--rewrite | --no-rewrite]

Reads a .env file (default ./.env), lets you pick which variables to store in
the profile, then offers to replace their values in the file with
secenv://<profile>/NAME references, so the file holds no secrets and can be
committed. Empty values and lines that already hold references are skipped.
With <profile>/NAME items, only those are imported and there is no picker.

  -e, --env <file>   the file to read (default ./.env)
  --all              import every variable, no picker (default without a terminal)
  --rewrite          replace the imported values in the file without asking
  --no-rewrite       leave the file as it is

Rewriting does not wipe the old bytes from the disk: rotate keys that matter.`,

  export: `usage: secenv export <profile> [--out <file>] [--allow-pipe]

Prints a profile in .env format (Touch ID), for example to move it to a new
Mac: the Secure Enclave key cannot be moved, so plaintext is the only way.

  --out <file>    write a file with mode 0600 instead (see below)
  --allow-pipe    allow writing into a pipe

--out with a new file writes the whole profile. With an existing file it fills
it in: secenv://<profile>/NAME and bare secenv://NAME references become the
values, secrets the file neither sets nor references are appended, every other
line stays as it is (a variable already set to a plain value is kept). The file
is set to mode 0600. Do not commit it afterwards.

  secenv export myapp --out myapp.env      # new Mac: secenv import myapp -e myapp.env
  secenv export myapp --out .env           # fill the project's .env`,

  list: `usage: secenv list [<profile>] [--older-than <n>d|w|m]   (also: ls)

Without a profile: lists the profiles (no Touch ID). With one: prints its
secrets (Touch ID) with a masked preview to tell tokens apart, the start and
the last 4 characters as provider consoles show them (sk-ant-api03-cxx****cQAA),
and the dates they were added and last changed. Values shorter than 24
characters or spanning several lines show only their size. In a pipe it prints
the names only.

  --older-than 90d   only secrets whose value has not changed for 90 days
                     (d, w or m; a rotation check). Secrets with no known
                     date count as old.`,

  get: `usage: secenv get <profile>/NAME [--allow-pipe]

Prints one secret value to the terminal (Touch ID). Into a pipe or $(...) it
refuses unless --allow-pipe is given: a secret on a command line is visible to
every process through ps. Prefer \`secenv run\`, which passes secrets through
the environment:
  secenv run myapp -- sh -c 'tool --key "$API_KEY"'`,

  rm: `usage: secenv rm <profile>/NAME [<profile>/NAME...]

Removes secrets from a profile (Touch ID). A name that is not in the profile
is an error and nothing is removed. To delete a whole profile:
secenv profile rm <profile>.`,

  cp: `usage: secenv cp <profile>/NAME <profile>[/NAME] [-f]

Copies one secret into another profile, optionally under a new name. The
destination profile is created if needed. Two profiles mean two decryptions
(two Touch ID prompts).

  -f, --force   overwrite the secret if it already exists there

  secenv cp ai/OPENAI_API_KEY myapp
  secenv cp myapp/OPENAI_API_KEY myapp-staging/OPENAI_KEY`,

  mv: `usage: secenv mv <profile>/NAME <profile>[/NAME] [-f]

Moves one secret to another profile, or renames it inside the same profile.
Same rules as cp; the source secret is removed afterwards.

  -f, --force   overwrite the secret if it already exists there

  secenv mv myapp/OPENAI_KEY myapp/OPENAI_API_KEY
  secenv mv myapp/STRIPE_KEY billing`,

  profile: `usage: secenv profile <action>

  rm <profile> [-y]     delete a profile and all its secrets (asks)
  mv <old> <new>        rename a profile
  cp <src> <dst>        copy a profile

These work on the encrypted files: no Touch ID. To list profiles or their
secrets use \`secenv list\`; to print one use \`secenv export\`.`,

  trust: `usage: secenv trust <action>

  ls [<profile>]        list trusted directories (only those using <profile>)
  rm [<dir>]            revoke a directory (default: the current one)
  prune                 drop entries of directories that no longer exist

The first \`secenv run\` of a profile in a directory asks whether to trust that
directory with it; the answers are kept in ~/.config/secenv/trusted.json.
No Touch ID.`,

  run: `usage: secenv run [<profile>] [-e <file> | --no-env] -- <command...>
       secenv run <profile>/NAME [<profile>/NAME...] [-e <file> | --no-env] -- <command...>

Decrypts the profile (Touch ID) and runs the command with the secrets in its
environment. Nothing is written to disk. The exit code is the command's.
<profile>/NAME items pass only the listed secrets (all from one profile).

Profile, in this order: the argument, $SECENV_PROFILE, ./.secenv (one line),
or secenv://<profile>/NAME references in the env file. References may name
other profiles too, but each profile is a separate decryption (one Touch ID
each): keep one profile per project.

  -e, --env <file>   env file to read instead of ./.env
  --no-env           read no env file

Env file: ./.env is read like dotenv when present. A value secenv://NAME or
secenv://<profile>/NAME is replaced with that secret and only the referenced
secrets are passed; other values pass as they are, except PATH, NODE_OPTIONS,
NODE_PATH, DYLD_* and LD_*, which are ignored.

The first use of a profile in a directory asks whether to trust the directory
with it, whatever named the profile (\`secenv trust ls\`). Before every
decryption one line is printed:  secenv: <profile> (<source>) -> <command>

Examples:
  secenv run myapp -- node app.js
  secenv run myapp/{OPENAI_API_KEY,DB_URL} -- node script.js
  secenv run -- npm start            # profile from .secenv or .env references
  secenv run myapp --no-env -- env`,
};

function help(cmd) {
  if (cmd === 'ls') cmd = 'list';
  process.stdout.write(cmd && HELP[cmd] ? `${HELP[cmd]}\n` : USAGE);
  process.exit(0);
}

// Usage errors: the message, the one-line usage, and where to read more.
function usageError(cmd, msg, action) {
  let usage = HELP[cmd].split('\n')[0].replace(/^usage: /, '');
  // For `profile <action>` show that action's own line from the help text.
  const line = action && HELP[cmd].split('\n').find((l) => l.startsWith(`  ${action} `) || l === `  ${action}`);
  if (line) usage = `secenv ${cmd} ${line.trim().replace(/\s{2,}.*$/, '')}`;
  die(`${msg}\nusage: ${usage}\nRun "secenv ${cmd} --help" for details.`);
}

function die(msg, code = 1) {
  process.stderr.write(`secenv: ${msg}\n`);
  process.exit(code);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir applies the mode only when it creates the directory
  if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Plain variables an env file may not set: they choose which binary runs, what
// gets loaded into it, which startup files a shell reads, or where a tool's
// own config (and its credential helpers) comes from. The list is best effort;
// the variables a file sets are also part of the directory trust (approveRun).
const UNSAFE_PUBLIC_ENV =
  /^(PATH|HOME|SHELL|ENV|BASH_ENV|ZDOTDIR|SHELLOPTS|PS4|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_REPL_EXTERNAL_MODULE|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONUSERBASE|PERL5LIB|PERL5OPT|PERL5DB|RUBYOPT|RUBYLIB|GIT_.*|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|DOCKER_CONFIG|DOCKER_HOST|DYLD_.*|LD_.*|.*_PROXY|.*_proxy)$/;
// CSI and OSC sequences, then any remaining control character except newline.
const TERMINAL_CONTROL = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x09\x0b-\x1f\x7f]/g;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// Text that comes from a repository (command arguments, file names) is shown
// in the trust prompt and in messages. Control characters and invisible
// Unicode could redraw the line or hide part of it (ESC [2K CR "node app.js"
// after the real command shows only "node app.js"), so they are made visible,
// and arguments holding whitespace or quotes are quoted the way a shell would.
const INVISIBLE = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
export function visible(s) {
  return String(s).replace(INVISIBLE, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    if (c === '\x1b') return '\\e';
    const code = c.charCodeAt(0);
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}
export function showArg(s) {
  const v = visible(s);
  if (v !== String(s) || v === '' || /[\s'"\\$`]/.test(v)) return `'${v.replace(/'/g, "'\\''")}'`;
  return v;
}
export const showCommand = (cmd) => cmd.map(showArg).join(' ');

function profileFile(name) {
  if (!name || !PROFILE_NAME.test(name) || name === '.' || name === '..') {
    die('profile name: only letters, digits, dot, hyphen and underscore');
  }
  return path.join(STORE, `${name}.age`);
}

function checkKey(key) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) die(`invalid variable name: ${key}`);
}

// Splits command arguments into options and positionals. `spec` maps every
// accepted option to its field: { '--all': 'all' } for a switch, and
// { '-e': ['env'] } for an option that takes a value. Anything else that
// starts with "-" is a usage error, so a typo is never taken for a name.
function parseArgs(cmd, args, spec = {}, action) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') {
      pos.push(a);
      continue;
    }
    const field = spec[a];
    if (field === undefined) usageError(cmd, `unknown option: ${a}`, action);
    if (Array.isArray(field)) {
      const v = args[++i];
      if (v === undefined || v === '') usageError(cmd, `${a} requires a value`, action);
      opts[field[0]] = v;
    } else opts[field] = true;
  }
  return { opts, pos };
}

// A secret is addressed as <profile>/NAME everywhere; a bare <profile> means
// the whole profile. Profile names cannot contain a slash, so the split is
// unambiguous. Returns null for anything without a slash.
function parseAddress(arg) {
  const i = arg.lastIndexOf('/');
  if (i === -1) return null;
  const profile = arg.slice(0, i);
  const name = arg.slice(i + 1);
  profileFile(profile);
  checkKey(name);
  return { profile, name };
}

// One or more <profile>/NAME items, all in one profile (one decryption).
function parseAddresses(cmd, args) {
  if (!args.length) usageError(cmd, 'missing <profile>/NAME');
  let profile;
  const names = [];
  for (const arg of args) {
    const addr = parseAddress(arg);
    if (!addr) {
      const hint = PROFILE_NAME.test(arg) ? ` (for example ${arg}/API_KEY)` : '';
      usageError(cmd, `expected <profile>/NAME, got "${arg}"${hint}`);
    }
    if (profile !== undefined && addr.profile !== profile) {
      die(`all secrets in one command must be in one profile: ${profile} and ${addr.profile}`);
    }
    profile = addr.profile;
    if (!names.includes(addr.name)) names.push(addr.name);
  }
  return { profile, names };
}

// ---------- external tools ----------

// age and age-plugin-se are looked up in fixed system directories, never in
// PATH: under `npm run` the repository's node_modules/.bin comes first on PATH,
// and a repository must not be able to substitute the binary that sees the
// plaintext. SECENV_TOOL_DIRS (colon-separated) replaces the list, for tests.
const TOOL_DIRS = (process.env.SECENV_TOOL_DIRS || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
  .split(':')
  .filter(Boolean);
const TOOL_ENV = { ...process.env, PATH: TOOL_DIRS.join(':') };

function findTool(name) {
  for (const dir of TOOL_DIRS) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

function tool(name) {
  const file = findTool(name);
  if (!file) die(`"${name}" not found in ${TOOL_DIRS.join(', ')}. Run install.sh or secenv setup.`);
  return file;
}

function need(cmd) {
  tool(cmd);
}

// ---------- dotenv parsing ----------

export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let [, key, val] = m;
    if (val.startsWith('"') && val.lastIndexOf('"') > 0) {
      const esc = { n: '\n', r: '\r', '"': '"', '\\': '\\' };
      val = val.slice(1, val.lastIndexOf('"')).replace(/\\([nr"\\])/g, (_, c) => esc[c]);
    } else if (val.startsWith("'") && val.lastIndexOf("'") > 0) {
      val = val.slice(1, val.lastIndexOf("'"));
    } else {
      val = val.replace(/\s+#.*$/, '').trim();
    }
    out[key] = val;
  }
  return out;
}

// Values are written so that every common reader (secenv, Node's --env-file,
// Docker Compose, python-dotenv, dotenv) gets them back unchanged:
// - unquoted when they consist of characters no reader treats specially, which
//   covers typical API keys and tokens (sk-ant-api03-...);
// - otherwise in single quotes, which are literal: no escapes, no $VAR
//   expansion, # is not a comment, spaces are kept;
// - a value with a single quote cannot be single-quoted, but unquoted quotes
//   inside a value are read literally too, so it stays unquoted unless it
//   holds what breaks unquoted values: # (a comment to Node), $ (expanded by
//   Compose), a line break, spaces at either end, or a quote at the start;
// - only then double quotes with escapes. Inside them readers disagree on \",
//   \\ and $ (Node stops at \", Compose expands $VAR), so values that also
//   hold those are reported by warnDoubleQuoted.
const PLAIN_VALUE = /^[A-Za-z0-9_\-.:\/+=@,%~]*$/;
function quoteKind(v) {
  const s = String(v);
  if (PLAIN_VALUE.test(s)) return 'plain';
  if (!/['\n\r]/.test(s)) return 'single';
  if (!/[#$\n\r]/.test(s) && s === s.trim() && !/^['"`]/.test(s)) return 'plain';
  return 'double';
}
const ambiguousQuoted = (v) => quoteKind(v) === 'double' && /["\\$]/.test(String(v));
const quoteDotenv = (v) => {
  const s = String(v);
  const kind = quoteKind(s);
  if (kind === 'plain') return s;
  if (kind === 'single') return `'${s}'`;
  return `"${s.replace(/[\\"\n\r]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r' })[c])}"`;
};

// Warns about variables written double-quoted (see quoteDotenv).
function warnDoubleQuoted(odd) {
  if (odd.length) {
    process.stderr.write(
      `secenv: ${odd.join(', ')}: the value mixes a single quote with " \\ or $ and also holds # $, a line break ` +
        'or spaces at the ends, so no quoting suits every reader: secenv and python-dotenv read it back exactly, ' +
        'Node --env-file and Docker Compose may not.\n',
    );
  }
}

export function formatDotenv(data) {
  return Object.keys(data)
    .sort()
    .map((k) => `${k}=${quoteDotenv(data[k])}\n`)
    .join('');
}

// Fills an existing dotenv file with a profile's values: a reference to the
// profile (secenv://<profile>/NAME, or a bare secenv://NAME) becomes the value,
// secrets the file neither sets nor references are appended, every other line stays
// as it is. A variable the file already sets to a plain value is kept.
export function mergeDotenv(text, profile, values) {
  const report = { replaced: [], appended: [], kept: [], missing: [], doubleQuoted: [] };
  const seen = new Set();
  const lines = text.split(/\r?\n/).map((line) => {
    const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m) return line;
    const key = m[2];
    seen.add(key);
    const value = parseDotenv(line)[key] ?? '';
    const ref = value.match(SECRET_REF);
    if (ref) {
      if (ref[1] && ref[1] !== profile) return line; // another profile's secret
      if (!(ref[2] in values)) {
        report.missing.push(key);
        return line;
      }
      report.replaced.push(key);
      if (ambiguousQuoted(values[ref[2]])) report.doubleQuoted.push(key);
      seen.add(ref[2]); // referenced under another name: not appended again
      return `${m[1]}${key}=${quoteDotenv(values[ref[2]])}`;
    }
    if (key in values && value !== values[key]) report.kept.push(key);
    return line;
  });
  const extra = Object.keys(values).filter((k) => !seen.has(k)).sort();
  if (extra.length) {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const k of extra) lines.push(`${k}=${quoteDotenv(values[k])}`);
    lines.push('');
    report.appended = extra;
    report.doubleQuoted.push(...extra.filter((k) => ambiguousQuoted(values[k])));
  }
  return { text: lines.join('\n'), ...report };
}

// ---------- age helpers ----------

function readRecipient() {
  if (!fs.existsSync(RECIPIENT)) die('key not created. Run: secenv init');
  return fs.readFileSync(RECIPIENT, 'utf8').trim();
}

function encryptTo(file, plaintext) {
  const r = spawnSync(tool('age'), ['-r', readRecipient()], {
    input: plaintext,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: TOOL_ENV, // age finds age-plugin-se through PATH as well
  });
  if (r.status !== 0) die('could not encrypt (age returned an error)');
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, r.stdout, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file); // atomic replace
}

function decryptFrom(file) {
  const r = spawnSync(tool('age'), ['-d', '-i', IDENTITY, file], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    env: TOOL_ENV,
  });
  if (r.status !== 0) die('could not decrypt (Touch ID cancelled or key does not match)');
  return r.stdout;
}

// A profile is an encrypted JSON object of entries:
//   { "KEY": { "value": "...", "added": "<ISO time>", "updated": "<ISO time>" } }
// Dates live inside the ciphertext, like the key names.
function loadProfile(name, { mustExist = false } = {}) {
  const file = profileFile(name);
  if (!fs.existsSync(file)) {
    if (mustExist) die(`profile "${name}" not found. Create it: secenv set ${name}/NAME`);
    return {};
  }
  let raw;
  try {
    raw = JSON.parse(decryptFrom(file));
  } catch {
    die('profile contents are corrupted');
  }
  // Profiles written before 0.7 stored plain strings; their dates are unknown.
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') raw[k] = { value: v, added: null, updated: null };
  return raw;
}

function saveProfile(name, data) {
  encryptTo(profileFile(name), JSON.stringify(data));
}

// Writes a value; `added` is set once, `updated` whenever the value changes.
function setSecret(data, key, value) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const prev = data[key];
  if (prev && prev.value === value) return false;
  data[key] = { value, added: prev?.added ?? now, updated: now };
  return true;
}

function secretValues(data) {
  return Object.fromEntries(Object.entries(data).map(([k, e]) => [k, e.value]));
}

// ---------- input ----------

// Piped stdin is read once, whole: a single key gets all of it (multi-line
// values are fine), several keys get one line each.
let pipedInput = null;

function readPiped() {
  if (pipedInput) return pipedInput;
  pipedInput = new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
  });
  return pipedInput;
}

async function promptPiped(label, total) {
  const text = (await readPiped()).replace(/\r?\n$/, '');
  if (total === 1) return text;
  pipedLines ??= text.split(/\r?\n/);
  if (!pipedLines.length) die(`not enough values on stdin (one line per key): ${label.replace(/: $/, '')}`);
  return pipedLines.shift();
}
let pipedLines = null;

function promptHidden(label, total = 1) {
  if (!process.stdin.isTTY) return promptPiped(label, total);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(label);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

// ---------- commands ----------

function cmdInit() {
  need('age');
  ensureDir(HOME);
  ensureDir(STORE);
  if (fs.existsSync(IDENTITY)) {
    console.log(`Key already exists: ${IDENTITY}`);
    return;
  }
  let r;
  if (process.env.SECENV_INSECURE_SOFTWARE_KEY === '1') {
    // For tests / machines without a Secure Enclave only. The key sits on disk unprotected.
    console.error('WARNING: creating a software key without Secure Enclave protection.');
    r = spawnSync(tool('age-keygen'), ['-o', IDENTITY], { stdio: ['ignore', 'inherit', 'inherit'], env: TOOL_ENV });
  } else {
    r = spawnSync(
      tool('age-plugin-se'),
      ['keygen', '--access-control=any-biometry', '-o', IDENTITY],
      { stdio: ['ignore', 'inherit', 'inherit'], env: TOOL_ENV },
    );
  }
  if (r.status !== 0 || !fs.existsSync(IDENTITY)) die('could not create the key');
  fs.chmodSync(IDENTITY, 0o600);
  const text = fs.readFileSync(IDENTITY, 'utf8');
  const m = text.match(/public key:\s*(age1\S+)/i);
  if (!m) {
    die(
      `key created, but the public part could not be found automatically.\n` +
        `Write it (the age1se1... line) to ${RECIPIENT} manually.`,
    );
  }
  fs.writeFileSync(RECIPIENT, `${m[1]}\n`, { mode: 0o600 });
  console.log(`Done. Public key: ${m[1]}`);
  console.log('Next: secenv set myapp/OPENAI_API_KEY   (or secenv import myapp)');
}

async function cmdSet(args) {
  const { pos } = parseArgs('set', args);
  const { profile: name, names: keys } = parseAddresses('set', pos);
  const data = loadProfile(name);
  for (const k of keys) setSecret(data, k, await promptHidden(`${k}: `, keys.length));
  saveProfile(name, data);
  console.log(`Saved to profile "${name}": ${keys.join(', ')}`);
}

// Interactive multi-select on the terminal: arrows/j/k move, space toggles,
// `a` toggles all, enter confirms, esc/q/ctrl-c cancels. Returns the chosen
// items, or null when cancelled. Values are never shown, only the names.
function pickKeys(title, items) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stderr;
    const selected = new Set(items);
    let cursor = 0;
    let lines = 0;
    const render = () => {
      if (lines) out.write(`\x1b[${lines}A`);
      const rows = [
        `${title}  (space: toggle, a: all/none, enter: confirm, esc: cancel)`,
        ...items.map((k, i) => `${i === cursor ? ' ❯ ' : '   '}${selected.has(k) ? '◉' : '○'} ${k}`),
      ];
      out.write(rows.map((r) => `\x1b[2K${r}`).join('\n') + '\n');
      lines = rows.length;
    };
    const finish = (result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      out.write('\x1b[?25h');
      resolve(result);
    };
    // A chunk may carry several keys (fast typing, paste, test drivers); split
    // it into single characters and CSI sequences such as ESC [ A.
    const tokens = (chunk) => chunk.match(/\u001b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? [];
    const onData = (chunk) => {
      for (const ch of tokens(chunk)) {
        if (ch === '\u0003' || ch === '\u001b' || ch === 'q') return finish(null);
        if (ch === '\r' || ch === '\n') return finish(items.filter((k) => selected.has(k)));
        if (ch === ' ') selected.has(items[cursor]) ? selected.delete(items[cursor]) : selected.add(items[cursor]);
        else if (ch === 'a') {
          if (selected.size === items.length) selected.clear();
          else items.forEach((k) => selected.add(k));
        } else if (ch === '\u001b[A' || ch === 'k') cursor = (cursor + items.length - 1) % items.length;
        else if (ch === '\u001b[B' || ch === 'j') cursor = (cursor + 1) % items.length;
      }
      render();
    };
    out.write('\x1b[?25l');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    render();
  });
}

// Replaces the values of `keys` in a dotenv file with secenv:// references,
// keeping every other line (comments, order, other variables) as it is.
function rewriteDotenv(file, profile, keys) {
  const set = new Set(keys);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).map((line) => {
    const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return m && set.has(m[2]) ? `${m[1]}${m[2]}=secenv://${profile}/${m[2]}` : line;
  });
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join('\n'), { mode, flag: 'wx' });
  fs.renameSync(tmp, file);
}

async function cmdImport(args) {
  const { opts, pos } = parseArgs('import', args, {
    '-e': ['file'],
    '--env': ['file'],
    '--all': 'all',
    '--rewrite': 'rewrite',
    '--no-rewrite': 'noRewrite',
  });
  if (opts.rewrite && opts.noRewrite) usageError('import', '--rewrite and --no-rewrite exclude each other');
  let rewrite = opts.rewrite ? true : opts.noRewrite ? false : null; // null: ask
  const file = opts.file ?? '.env';
  if (!pos.length) usageError('import', 'missing profile');
  let name;
  let only = null;
  if (pos.length === 1 && !pos[0].includes('/')) name = pos[0];
  else {
    const stray = pos.slice(1).find((a) => !a.includes('/')) ?? pos.find((a) => !a.includes('/'));
    if (stray) usageError('import', `unexpected argument: ${stray} (a file goes after -e)`);
    ({ profile: name, names: only } = parseAddresses('import', pos));
    if (opts.all) usageError('import', '--all and <profile>/NAME items exclude each other');
  }
  const all = Boolean(opts.all);
  profileFile(name); // validate the name before touching the file
  if (!fs.existsSync(file)) usageError('import', `file not found: ${file}`);

  const parsed = parseDotenv(fs.readFileSync(file, 'utf8'));
  // Skipped: lines that already reference secenv (nothing to import) and
  // empty values (a placeholder, not a secret; stored it would only make the
  // variable look set).
  const empty = Object.keys(parsed).filter((k) => parsed[k] === '');
  const candidates = Object.keys(parsed).filter((k) => parsed[k] !== '' && !parsed[k].startsWith('secenv://'));
  if (empty.length) process.stderr.write(`secenv: skipping empty: ${empty.join(', ')}\n`);
  if (!candidates.length) die(`no importable variables in ${file} (empty values and existing secenv:// references are skipped)`);

  let keys;
  if (only) {
    const isEmpty = only.filter((k) => empty.includes(k));
    if (isEmpty.length) die(`empty in ${file}, nothing to import: ${isEmpty.join(', ')}`);
    const unknown = only.filter((k) => !candidates.includes(k));
    if (unknown.length) die(`not in ${file}: ${unknown.join(', ')}`);
    keys = only;
  } else if (all || !process.stdin.isTTY) {
    keys = candidates;
  } else {
    keys = await pickKeys(`Import into profile "${name}" from ${file}:`, candidates);
    if (keys === null) die('cancelled');
    if (!keys.length) die('nothing selected');
  }

  const data = loadProfile(name);
  const overwritten = keys.filter((k) => k in data && data[k].value !== parsed[k]);
  if (overwritten.length) process.stderr.write(`secenv: overwriting in "${name}": ${overwritten.join(', ')}\n`);
  for (const k of keys) setSecret(data, k, parsed[k]);
  saveProfile(name, data);
  console.log(`Imported ${keys.length} of ${candidates.length} variables into profile "${name}": ${keys.join(', ')}`);

  if (rewrite === null && process.stdin.isTTY) {
    rewrite = await confirm(`Replace those values in ${file} with secenv://${name}/NAME references?`);
  }
  if (rewrite) {
    rewriteDotenv(file, name, keys);
    console.log(`Rewrote ${file}: imported values are now secenv:// references; the file can be committed.`);
    console.log('The old plaintext may remain on disk (APFS does not wipe it); rotate keys that matter.');
  } else {
    console.log(`Now delete the source file (rm ${file}) and rotate any keys that were in it.`);
  }
}

// Reads file names only, so no decryption and no Touch ID.
function cmdProfiles() {
  let files = [];
  try {
    files = fs.readdirSync(STORE);
  } catch {}
  const names = files.filter((f) => f.endsWith('.age')).map((f) => f.slice(0, -4)).sort();
  if (!names.length) {
    process.stderr.write('No profiles yet. Create one: secenv set myapp/OPENAI_API_KEY\n');
    return;
  }
  names.forEach((n) => console.log(n));
}

function existingProfileFile(name) {
  const file = profileFile(name);
  if (!fs.existsSync(file)) die(`profile "${name}" not found`);
  return file;
}

function trustedDirsFor(name) {
  return Object.entries(readTrusted())
    .filter(([, entry]) => name in entry)
    .map(([dir]) => dir);
}

async function cmdProfileRm(name, yes) {
  const file = existingProfileFile(name);
  if (!yes) {
    if (!process.stdin.isTTY) die('refusing to delete without a terminal; add -y');
    if (!(await confirm(`Delete profile "${name}" and all its secrets? This cannot be undone.`))) die('cancelled');
  }
  fs.unlinkSync(file);
  // Drop approvals for the deleted profile, so a profile recreated later under
  // the same name is not silently trusted by old projects.
  const trusted = readTrusted();
  const dirs = trustedDirsFor(name);
  if (dirs.length) {
    for (const dir of dirs) {
      delete trusted[dir][name];
      if (!Object.keys(trusted[dir]).length) delete trusted[dir];
    }
    writeTrusted(trusted);
  }
  console.log(`Deleted profile "${name}".`);
}

function cmdProfileMv(from, to) {
  const src = existingProfileFile(from);
  const dst = profileFile(to);
  if (fs.existsSync(dst)) die(`profile "${to}" already exists`);
  fs.renameSync(src, dst);
  console.log(`Renamed profile "${from}" to "${to}".`);
  const dirs = trustedDirsFor(from);
  if (dirs.length) {
    console.log(`These projects select "${from}" in .secenv; update the file to "${to}":`);
    dirs.forEach((dir) => console.log(`  ${dir}`));
  }
}

function cmdProfileCp(from, to) {
  const src = existingProfileFile(from);
  const dst = profileFile(to);
  // The copy stays encrypted to the same key, so no decryption is needed.
  try {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code === 'EEXIST') die(`profile "${to}" already exists`);
    throw e;
  }
  fs.chmodSync(dst, 0o600);
  console.log(`Copied profile "${from}" to "${to}".`);
}

// Plaintext dump in .env format, e.g. to move secrets to a new Mac (the Secure
// Enclave key cannot be moved). Same guard as get: terminal only by default.
function cmdExport(args) {
  const { opts, pos } = parseArgs('export', args, { '--out': ['out'], '--allow-pipe': 'allowPipe' });
  if (pos.length !== 1) usageError('export', pos.length ? `unexpected argument: ${pos[1]}` : 'missing profile');
  const [name] = pos;
  const { allowPipe, out } = opts;
  if (name.includes('/')) usageError('export', 'export takes a whole profile, not <profile>/NAME');
  existingProfileFile(name);
  if (!out && !process.stdout.isTTY && !allowPipe) {
    die(
      'refusing to write plaintext secrets into a pipe. ' +
        'To write a file use --out <file> (created with mode 0600); ' +
        'if you really need a pipe, add --allow-pipe.',
    );
  }
  const merge = out && fs.existsSync(out);
  const data = loadProfile(name, { mustExist: true });
  const values = secretValues(data);
  if (merge) return mergeExport(out, name, values);
  const text = formatDotenv(values);
  warnDoubleQuoted(Object.keys(values).filter((k) => ambiguousQuoted(values[k])));
  if (out) {
    // A shell redirect would use the umask (usually 0644); open the file here.
    try {
      fs.writeFileSync(out, text, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      die(`could not write ${out}: ${e.message}`);
    }
    process.stderr.write(`Wrote ${Object.keys(data).length} secrets from "${name}" to ${out} in plaintext (mode 0600). Delete it after use.\n`);
    return;
  }
  process.stdout.write(text);
  if (!process.stdout.isTTY) {
    process.stderr.write(`Exported ${Object.keys(data).length} secrets from "${name}" in plaintext. Delete the output after use.\n`);
  }
}

function mergeExport(file, profile, values) {
  const { text, replaced, appended, kept, missing, doubleQuoted } = mergeDotenv(fs.readFileSync(file, 'utf8'), profile, values);
  warnDoubleQuoted(doubleQuoted);
  const wide = (fs.statSync(file).mode & 0o077) !== 0;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  const say = (label, keys) => keys.length && process.stderr.write(`  ${label}: ${keys.join(', ')}\n`);
  process.stderr.write(`Filled ${file} with secrets from "${profile}" in plaintext:\n`);
  say('replaced references', replaced);
  say('appended', appended);
  say('kept existing values (differ from the profile)', kept);
  say(`references to secrets not in "${profile}", left as they are`, missing);
  if (!replaced.length && !appended.length) process.stderr.write('  nothing to change\n');
  process.stderr.write(`Mode is now 0600${wide ? ' (it was readable by other users)' : ''}. Delete the plaintext after use, or turn it back into references: secenv import ${profile} -e ${file} --rewrite\n`);
}

// Trusted directories (directory -> profiles), see approveRun.
function cmdTrustLs(profile) {
  const entries = Object.entries(readTrusted())
    .filter(([, entry]) => !profile || profile in entry)
    .sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    process.stderr.write('No trusted directories.\n');
    return;
  }
  for (const [dir, entry] of entries) {
    const gone = !fs.existsSync(dir);
    const list = Object.entries(entry).map(([p, keys]) => (keys?.length ? `${p} (env file sets: ${keys.join(', ')})` : p));
    console.log(`${visible(dir)}  ->  ${list.join(', ')}${gone ? '  (directory gone, run: secenv trust prune)' : ''}`);
  }
}

function cmdTrustRm(target = '.') {
  const trusted = readTrusted();
  let dir = path.resolve(target);
  if (!(dir in trusted) && fs.existsSync(dir)) dir = fs.realpathSync(dir);
  if (!(dir in trusted)) die(`not trusted: ${dir}`);
  const list = Object.keys(trusted[dir]);
  delete trusted[dir];
  writeTrusted(trusted);
  console.log(`Revoked: ${visible(dir)} can no longer use ${list.map((p) => `"${p}"`).join(', ')} without asking.`);
}

// Drops approvals whose directory is gone, so a different project cloned into
// the same path later is asked again.
function cmdTrustPrune() {
  const trusted = readTrusted();
  const gone = Object.keys(trusted).filter((dir) => !fs.existsSync(dir));
  gone.forEach((dir) => delete trusted[dir]);
  if (gone.length) writeTrusted(trusted);
  console.log(gone.length ? `Removed ${gone.length} deleted director${gone.length === 1 ? 'y' : 'ies'}:\n  ${gone.join('\n  ')}` : 'Nothing to prune.');
}


async function cmdProfile(args) {
  const [action, ...rest] = args;
  const { opts, pos } = parseArgs('profile', rest, action === 'rm' ? { '-y': 'yes', '--yes': 'yes' } : {}, action);
  const needArgs = (n) => {
    if (pos.length !== n) usageError('profile', `${action}: expected ${n} argument${n === 1 ? '' : 's'}, got ${pos.length}`, action);
  };
  switch (action) {
    case 'rm':
      needArgs(1);
      return cmdProfileRm(pos[0], opts.yes);
    case 'mv':
      needArgs(2);
      return cmdProfileMv(pos[0], pos[1]);
    case 'cp':
      needArgs(2);
      return cmdProfileCp(pos[0], pos[1]);
    case 'ls':
    case 'list':
      return usageError('profile', 'to list profiles: secenv list');
    case 'export':
      return usageError('profile', `export is a top-level command: secenv export ${pos[0] ?? '<profile>'}`);
    case 'trust':
      return usageError('profile', 'trust is a top-level command: secenv trust ls|rm|prune');
    default:
      usageError('profile', action ? `unknown action: ${action}` : 'missing action (rm, mv, cp)');
  }
}

function cmdTrust(args) {
  const [action, ...rest] = args;
  const { pos } = parseArgs('trust', rest, {}, action);
  if (action === 'ls' && pos.length <= 1) return cmdTrustLs(pos[0]);
  if (action === 'rm' && pos.length <= 1) return cmdTrustRm(pos[0]);
  if (action === 'prune' && !pos.length) return cmdTrustPrune();
  if (['ls', 'rm', 'prune'].includes(action)) usageError('trust', `${action}: unexpected argument: ${pos.at(-1)}`, action);
  usageError('trust', action ? `unknown action: ${action}` : 'missing action (ls, rm, prune)');
}

const PERIOD_DAYS = { d: 1, w: 7, m: 30 };

// Enough of a value to tell which token it is, in the style provider consoles
// use (sk-ant-api03-cxx****cQAA): the start, which usually names the provider
// and the key type, and the last 4 characters, which consoles show to identify
// a key. At most a third of the value is revealed, so at least 16 characters
// stay hidden; shorter values (passwords, PINs) and multi-line ones (PEM keys)
// show only their size.
export function maskValue(value) {
  const v = String(value);
  if (v.includes('\n')) return `(${v.split('\n').length} lines)`;
  if (v.length < 24) return `(${v.length} char${v.length === 1 ? '' : 's'})`;
  const head = Math.min(16, Math.floor(v.length / 3) - 4);
  return `${v.slice(0, head)}****${v.slice(-4)}`;
}

function cmdList(args) {
  const { opts, pos } = parseArgs('list', args, { '--older-than': ['olderThan'] });
  let olderDays;
  if (opts.olderThan !== undefined) {
    const m = opts.olderThan.match(/^(\d+)([dwm]?)$/);
    if (!m) usageError('list', '--older-than takes a period such as 90d, 12w or 6m');
    olderDays = Number(m[1]) * PERIOD_DAYS[m[2] || 'd'];
  }
  if (pos.length > 1) usageError('list', `unexpected argument: ${pos[1]}`);
  const [name] = pos;
  if (!name) {
    if (olderDays !== undefined) usageError('list', '--older-than needs a profile');
    return cmdProfiles();
  }
  if (name.includes('/')) usageError('list', 'list takes a profile, not <profile>/NAME');
  const data = loadProfile(name, { mustExist: true });
  const day = (iso) => (iso ? iso.slice(0, 10) : '—');
  let keys = Object.keys(data).sort();
  if (olderDays !== undefined) {
    const limit = Date.now() - olderDays * 86400000;
    // A key with no known date (written before 0.7) counts as old.
    keys = keys.filter((k) => !data[k].updated || Date.parse(data[k].updated) < limit);
  }
  if (!process.stdout.isTTY) return keys.forEach((k) => console.log(k)); // names only for scripts
  const width = Math.max(0, ...keys.map((k) => k.length));
  const previews = Object.fromEntries(keys.map((k) => [k, maskValue(data[k].value)]));
  const pwidth = Math.max(0, ...keys.map((k) => previews[k].length));
  for (const k of keys) {
    const e = data[k];
    console.log(`${k.padEnd(width)}   ${previews[k].padEnd(pwidth)}   added ${day(e.added)}   updated ${day(e.updated)}`);
  }
  if (!keys.length && olderDays !== undefined) process.stderr.write(`No secrets older than ${olderDays} days in "${name}".\n`);
}

function cmdGet(args) {
  const { opts, pos } = parseArgs('get', args, { '--allow-pipe': 'allowPipe' });
  const { allowPipe } = opts;
  if (pos.length > 1) usageError('get', 'one <profile>/NAME at a time');
  const { profile: name, names } = parseAddresses('get', pos);
  const [key] = names;
  if (!process.stdout.isTTY && !allowPipe) {
    die(
      'refusing to print a secret into a pipe or $(...): as a command-line argument it is ' +
        'visible to every process via ps and may end up in logs.\n' +
        'Prefer: secenv run <profile> -- sh -c \'cmd --key "$' + key + '"\'\n' +
        'If you really need it, add --allow-pipe.',
    );
  }
  const data = loadProfile(name, { mustExist: true });
  if (!(key in data)) die(`secret "${key}" not found in profile "${name}"`);
  const value = data[key].value;
  process.stdout.write(process.stdout.isTTY ? `${value}\n` : value);
}

// secenv cp|mv <profile>/KEY <profile>[/KEY]: one secret between profiles (or
// a rename inside one). Each profile involved is one decryption.
function cmdCopyKey(args, { move }) {
  const verb = move ? 'mv' : 'cp';
  const { opts, pos } = parseArgs(verb, args, { '-f': 'force', '--force': 'force' });
  if (pos.length !== 2) usageError(verb, pos.length < 2 ? 'need a source and a destination' : `unexpected argument: ${pos[2]}`);
  const from0 = parseAddress(pos[0]);
  if (!from0) usageError(verb, `source must be <profile>/NAME, got "${pos[0]}"`);
  const to0 = parseAddress(pos[1]) ?? { profile: pos[1], name: from0.name };
  profileFile(to0.profile);
  const src = { name: from0.profile };
  const dst = { name: to0.profile };
  const srcKey = from0.name;
  const dstKey = to0.name;
  if (src.name === dst.name && srcKey === dstKey) die('source and destination are the same');

  const from = loadProfile(src.name, { mustExist: true });
  if (!(srcKey in from)) die(`secret "${srcKey}" not found in profile "${src.name}"`);
  const same = src.name === dst.name;
  const to = same ? from : loadProfile(dst.name);
  if (dstKey in to && !opts.force) die(`"${dstKey}" already exists in profile "${dst.name}"; add -f to overwrite it`);
  to[dstKey] = { ...from[srcKey] }; // keeps added/updated
  if (move) delete from[srcKey];
  saveProfile(dst.name, to);
  if (move && !same) saveProfile(src.name, from);
  console.log(`${move ? 'Moved' : 'Copied'} ${src.name}/${srcKey} -> ${dst.name}/${dstKey}`);
}

function cmdRm(args) {
  const { pos } = parseArgs('rm', args);
  if (pos.length === 1 && !pos[0].includes('/') && PROFILE_NAME.test(pos[0])) {
    usageError('rm', `rm removes secrets: secenv rm ${pos[0]}/NAME. To delete the whole profile: secenv profile rm ${pos[0]}`);
  }
  const { profile: name, names: keys } = parseAddresses('rm', pos);
  const data = loadProfile(name, { mustExist: true });
  const missing = keys.filter((k) => !(k in data));
  if (missing.length) die(`not found in profile "${name}": ${missing.join(', ')} (nothing removed)`);
  for (const k of keys) delete data[k];
  saveProfile(name, data);
  console.log(`Removed from "${name}": ${keys.join(', ')}`);
}

// The profile in ./.secenv decides which secrets the launched code receives, so
// a cloned repository must not make that choice silently. The "directory ->
// profile" binding is remembered after explicit confirmation, together with
// the plain variables the env file set at that time: the file comes from the
// repository too, and what it sets reaches the command (see approveRun).
// trusted.json: { "<realpath of directory>": { "<profile>": ["VAR", ...] } }.
// Older files stored a string or a list of profiles per directory; both are
// read, with the variables unknown (null) until the next run binds them.
export function normalizeTrusted(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [dir, v] of Object.entries(raw)) {
    const entry = {};
    if (typeof v === 'string' || Array.isArray(v)) {
      for (const p of [v].flat()) if (typeof p === 'string' && PROFILE_NAME.test(p) && p !== '.' && p !== '..') entry[p] = null;
    } else if (v && typeof v === 'object') {
      for (const [p, keys] of Object.entries(v)) {
        if (!PROFILE_NAME.test(p) || p === '.' || p === '..') continue;
        entry[p] = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string' && ENV_NAME.test(k)).sort() : null;
      }
    }
    if (Object.keys(entry).length) out[dir] = entry;
  }
  return out;
}

function readTrusted() {
  try {
    return normalizeTrusted(JSON.parse(fs.readFileSync(TRUSTED, 'utf8')));
  } catch {
    return {};
  }
}

function writeTrusted(trusted) {
  ensureDir(HOME);
  fs.writeFileSync(TRUSTED, JSON.stringify(trusted, null, 2), { mode: 0o600 });
}

// Asks on the controlling terminal. When stdin is a pipe (data for the child,
// `npm run` with redirected input) the question goes to /dev/tty instead, so an
// approval can never be answered by piped data. Returns null without a terminal.
async function confirm(question) {
  let input = process.stdin;
  let fd = null;
  if (!input.isTTY) {
    try {
      fd = fs.openSync('/dev/tty', 'r+');
      input = new (await import('node:tty')).ReadStream(fd);
    } catch {
      return null;
    }
  }
  const rl = readline.createInterface({ input, output: process.stderr });
  const answer = await new Promise((resolve) => {
    rl.question(`${question} [y/N] `, resolve);
    rl.on('close', () => resolve('')); // EOF (terminal closed): no answer is "no"
  });
  rl.close();
  if (fd !== null) {
    input.destroy();
  }
  return /^y(es)?$/i.test(answer.trim());
}

function projectProfile() {
  const file = path.resolve('.secenv');
  if (!fs.existsSync(file)) return undefined;
  const profile = fs.readFileSync(file, 'utf8').trim();
  // Validate before the name reaches any prompt or message: the file comes from
  // the repository, so it must not be able to inject text into the question.
  if (!PROFILE_NAME.test(profile)) die(`invalid profile name in ${file}`);
  return profile;
}

// Every `run` needs an approval of (directory, profile), whatever named the
// profile: a repository's package.json script can pass the profile as an
// argument just as easily as through .secenv, and the Touch ID dialog shows
// neither the profile nor the command. The plain variables the env file sets
// are part of the approval: the file comes from the repository as well, and a
// variable such as BASH_ENV or AWS_CONFIG_FILE changes what the shown command
// loads. New variables ask again; removed ones are forgotten silently.
async function approveRun(profile, source, cmd, envKeys, envShown) {
  const dir = fs.realpathSync(process.cwd());
  const trusted = readTrusted();
  const known = trusted[dir]?.[profile]; // undefined: not trusted; null: trusted before 0.9, variables unknown
  const keys = [...envKeys].sort();
  const added = known ? keys.filter((k) => !known.includes(k)) : keys;
  if (known !== undefined && !added.length) {
    if (known === null || known.length !== keys.length) {
      trusted[dir][profile] = keys;
      writeTrusted(trusted);
    }
    return;
  }

  const lines = [
    known === undefined
      ? `secenv: first use of profile "${profile}" (${source}) in ${visible(dir)}`
      : `secenv: profile "${profile}" (${source}) is trusted in ${visible(dir)}, but ${envShown} now sets variables it did not before`,
    `  command: ${showCommand(cmd)}`,
  ];
  if (keys.length) lines.push(`  ${envShown} also sets: ${keys.join(', ')}${known ? `  (new: ${added.join(', ')})` : ''}`);
  lines.push(`Trust this directory to use "${profile}"${known === undefined ? '' : ' with these variables'} from now on?`);
  const ok = await confirm(lines.join('\n'));
  if (ok === null) {
    die(
      `profile "${profile}" (${source}) is not trusted in ${visible(dir)}` +
        (known === undefined ? '' : ` with the variables ${envShown} now sets (${added.join(', ')})`) +
        ' and there is no terminal to ask. Run it once interactively.',
    );
  }
  if (!ok) die('cancelled');
  trusted[dir] = { ...(trusted[dir] ?? {}), [profile]: keys };
  writeTrusted(trusted);
}

// `KEY=secenv://NAME` or `KEY=secenv://<profile>/NAME` in an env file: the
// value is taken from the profile. Returns { refs: {KEY: {profile, name}}, plain }.
const SECRET_REF = /^secenv:\/\/(?:([A-Za-z0-9._-]+)\/)?([A-Za-z_][A-Za-z0-9_]*)$/;

function splitReferences(vars, file) {
  const refs = {};
  const plain = {};
  for (const [k, v] of Object.entries(vars)) {
    const m = v.match(SECRET_REF);
    if (m) refs[k] = { profile: m[1], name: m[2] };
    else if (v.startsWith('secenv://')) die(`invalid secret reference in ${file}: ${k}=${v}`);
    else plain[k] = v;
  }
  return { refs, plain };
}

async function cmdRun(args) {
  const sep = args.indexOf('--');
  if (sep === -1) usageError('run', 'missing "--" before the command');
  if (sep === args.length - 1) usageError('run', 'missing command after "--"');
  const head = args.slice(0, sep);
  const cmd = args.slice(sep + 1);

  const { opts, pos } = parseArgs('run', head, { '-e': ['envFile'], '--env': ['envFile'], '--no-env': 'noEnv' });
  let { envFile } = opts;
  const { noEnv } = opts;
  if (envFile && noEnv) usageError('run', '--env and --no-env exclude each other');
  let profile;
  // `<profile>/NAME` items limit the child to the listed secrets only.
  let only = null;
  if (pos.length === 1 && !pos[0].includes('/')) profile = pos[0];
  else if (pos.length) {
    const stray = pos.slice(1).find((a) => !a.includes('/')) ?? pos.find((a) => !a.includes('/'));
    if (stray) usageError('run', `unexpected argument: ${stray} (either one <profile> or <profile>/NAME items)`);
    ({ profile, names: only } = parseAddresses('run', pos));
  }

  // Env file: --env <file>, else ./.env when present (like dotenv), unless --no-env.
  if (envFile && !fs.existsSync(envFile)) die(`--env: file not found: ${showArg(envFile)}`);
  if (!envFile && !noEnv && fs.existsSync('.env')) envFile = '.env';
  // The file name may come from a repository script too: show it safely.
  const envShown = envFile ? showArg(envFile) : null;
  const { refs, plain } = envFile ? splitReferences(parseDotenv(fs.readFileSync(envFile, 'utf8')), envShown) : { refs: {}, plain: {} };
  // An env file may come from the repository; it must not decide which binary
  // runs or what gets loaded into it. What it does set is shown in the trust
  // prompt and remembered with the approval (approveRun).
  const dropped = Object.keys(plain).filter((k) => UNSAFE_PUBLIC_ENV.test(k));
  for (const k of dropped) delete plain[k];
  if (dropped.length) process.stderr.write(`secenv: ignoring ${dropped.join(', ')} from ${envShown}\n`);

  let source = 'argument';
  if (!profile && process.env.SECENV_PROFILE) {
    profile = process.env.SECENV_PROFILE;
    source = 'SECENV_PROFILE';
  }
  if (!profile) {
    profile = projectProfile();
    source = profile ? '.secenv' : `${envShown} reference`;
  }
  // References may name a profile themselves: KEY=secenv://myapp/NAME. The
  // main profile (argument, SECENV_PROFILE, .secenv) serves references without
  // one; when there is no main profile, the references must agree on one.
  const refProfiles = [...new Set(Object.values(refs).map((r) => r.profile).filter(Boolean))];
  const bare = Object.values(refs).some((r) => !r.profile);
  if (!profile && refProfiles.length === 1) {
    profile = refProfiles[0];
    source = `${envShown} reference`;
  }
  if (!profile && refProfiles.length > 1 && bare) {
    die(`${envShown} mixes secenv://KEY with references to several profiles; name the profile in every reference or pass one`);
  }
  if (!profile && !refProfiles.length) {
    die('no profile specified (argument, SECENV_PROFILE, .secenv or secenv://<profile>/KEY in .env)');
  }
  if (profile) profileFile(profile); // validate the name before it is shown anywhere
  for (const r of Object.values(refs)) r.profile ??= profile;
  // Secrets wanted per profile: the explicit <profile>/KEY list, else exactly
  // the referenced names, else the whole main profile.
  const wanted = new Map(); // profile -> array of names, or null for "all"
  if (only) {
    const outside = Object.values(refs).filter((r) => r.profile !== profile || !only.includes(r.name));
    if (outside.length) {
      die(`${envShown} references secrets outside the allowed list: ${outside.map((r) => `${r.profile}/${r.name}`).join(', ')}`);
    }
    wanted.set(profile, only);
  } else if (Object.keys(refs).length) {
    for (const r of Object.values(refs)) {
      if (!wanted.has(r.profile)) wanted.set(r.profile, []);
      if (!wanted.get(r.profile).includes(r.name)) wanted.get(r.profile).push(r.name);
    }
  } else {
    wanted.set(profile, null);
  }
  for (const name of wanted.keys()) profileFile(name);

  const profiles = [...wanted.keys()];
  if (profiles.length > 1) {
    process.stderr.write(
      `secenv: warning: ${envShown} references ${profiles.length} profiles (${profiles.join(', ')}). ` +
        `Each one is a separate decryption, so expect ${profiles.length} Touch ID prompts per run. ` +
        'Prefer one profile per project: secenv set myapp/NAME, or secenv import myapp.\n',
    );
  }

  // All approvals first, then the decryptions: no prompts between Touch ID dialogs.
  const plainKeys = Object.keys(plain);
  for (const name of profiles) await approveRun(name, name === profile ? source : `${envShown} reference`, cmd, plainKeys, envShown);
  // The Touch ID dialog carries no context; this line is what the user can check.
  const shown = profiles.map((name) => (wanted.get(name) ? `${name}/${wanted.get(name).join(',')}` : name)).join(' ');
  process.stderr.write(`secenv: ${shown} (${source}) -> ${showCommand(cmd)}\n`);

  const loaded = new Map();
  for (const name of profiles) {
    const all = loadProfile(name, { mustExist: true });
    const names = wanted.get(name);
    if (names) {
      const missing = names.filter((k) => !(k in all));
      if (missing.length) die(`not found in profile "${name}": ${missing.join(', ')}`);
    }
    loaded.set(name, secretValues(all));
  }
  const secrets = {};
  if (only) for (const k of only) secrets[k] = loaded.get(profile)[k];
  else if (!Object.keys(refs).length) Object.assign(secrets, loaded.get(profile));
  for (const [k, r] of Object.entries(refs)) secrets[k] = loaded.get(r.profile)[r.name];
  // Like dotenv: a variable already set in the shell wins over the file's plain
  // value, so a repository file cannot override the user's environment. The
  // secrets come last: they are what the run asked for.
  const env = { ...plain, ...process.env, ...secrets };

  const child = spawn(cmd[0], cmd.slice(1), { env, stdio: 'inherit' });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => child.kill(sig));
  }
  child.on('error', (e) => die(`could not start ${showArg(cmd[0])}: ${e.message}`));
  child.on('exit', (code, signal) => {
    // Conventional shell exit code for a signal death; re-raising the signal
    // would hit our own forwarding handler above and exit with 0.
    if (signal) process.exit(128 + (os.constants.signals[signal] ?? 0));
    else process.exit(code ?? 1);
  });
}

// ---------- setup ----------

function cmdCompletion(shell) {
  if (shell !== 'zsh') usageError('completion', shell ? `unsupported shell: ${shell} (only zsh)` : 'missing shell name');
  if (!fs.existsSync(COMPLETION_FILE)) {
    die('completion file not found next to secenv. If you installed with install.sh, it already set up the completion.');
  }
  process.stdout.write(fs.readFileSync(COMPLETION_FILE, 'utf8'));
}

function has(cmd) {
  return findTool(cmd) !== null;
}

function brewPrefix() {
  const r = spawnSync(findTool('brew') ?? 'brew', ['--prefix'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// One-shot setup for npm installs: dependencies, key, completion.
// Safe to re-run: every step skips what is already in place.
async function cmdSetup() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    die('secenv needs a Mac with Apple Silicon (Secure Enclave and Touch ID).');
  }

  const missing = ['age', 'age-plugin-se'].filter((c) => !has(c));
  if (missing.length) {
    const brew = brewPrefix();
    const install = `brew install ${missing.join(' ')}`;
    if (!brew) die(`missing: ${missing.join(', ')}. Install Homebrew (https://brew.sh), then run: ${install}`);
    if (!process.stdin.isTTY) die(`missing: ${missing.join(', ')}. Run: ${install}`);
    if (!(await confirm(`Missing ${missing.join(', ')}. Run "${install}" now?`))) die(`cancelled. Run: ${install}`);
    const r = spawnSync(findTool('brew') ?? 'brew', ['install', ...missing], { stdio: 'inherit' });
    const still = missing.filter((c) => !has(c));
    if (r.status !== 0 || still.length) die(`"${install}" failed; still missing: ${still.join(', ') || missing.join(', ')}`);
  }
  console.log('✓ age and age-plugin-se installed');

  cmdInit();

  const brew = brewPrefix();
  const compDir = brew && path.join(brew, 'share', 'zsh', 'site-functions');
  if (!fs.existsSync(COMPLETION_FILE)) {
    console.log('• zsh completion: skipped (installed by install.sh)');
  } else if (compDir && fs.existsSync(compDir)) {
    try {
      fs.copyFileSync(COMPLETION_FILE, path.join(compDir, '_secenv'));
      console.log(`✓ zsh completion -> ${compDir}/_secenv (open a new terminal)`);
    } catch {
      console.log('• zsh completion: could not write it; add to ~/.zshrc after compinit:');
      console.log('    source <(secenv completion zsh)');
    }
  } else {
    console.log('• zsh completion: add to ~/.zshrc after compinit:');
    console.log('    source <(secenv completion zsh)');
  }
}

// ---------- skill for AI coding agents ----------

function cmdSkill(args) {
  const [action, ...rest] = args;
  const { opts, pos } = parseArgs('skill', rest, { '-f': 'force', '--force': 'force' }, action);
  if (action !== 'install') usageError('skill', action ? `unknown action: ${action}` : 'missing action (install)');
  if (pos.length > 1) usageError('skill', `unexpected argument: ${pos[1]}`);
  if (!fs.existsSync(SKILL_FILE)) {
    die('skill file not found next to secenv (install.sh copies only the CLI). Copy .agents/skills/secenv from the repository checkout instead.');
  }
  const dst = path.join(path.resolve(pos[0] ?? path.join(os.homedir(), '.claude', 'skills')), 'secenv', 'SKILL.md');
  if (fs.existsSync(dst) && !opts.force) die(`${dst} already exists; add -f to overwrite it`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(SKILL_FILE, dst);
  console.log(`Installed the secenv skill: ${dst}`);
}

// ---------- version and update ----------

function readPackage() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'));
  } catch {
    return null; // install.sh copies only this script
  }
}

function cmdVersion() {
  console.log(readPackage()?.version ?? 'unknown (installed with install.sh)');
}

function newer(a, b) {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function refreshBrewCompletion() {
  const brew = brewPrefix();
  const target = brew && path.join(brew, 'share', 'zsh', 'site-functions', '_secenv');
  if (target && fs.existsSync(target) && fs.existsSync(COMPLETION_FILE)) {
    try {
      fs.copyFileSync(COMPLETION_FILE, target);
      console.log(`✓ zsh completion refreshed: ${target}`);
    } catch {}
  }
}

// Sections of CHANGELOG.md newer than `from`, up to and including `to`.
export function changelogBetween(text, from, to) {
  const out = [];
  for (const part of text.split(/^(?=## \[)/m)) {
    const v = part.match(/^## \[(\d+\.\d+\.\d+)\]/)?.[1];
    // Drop trailing link reference lines such as "[0.5.0]: https://...".
    if (v && newer(v, from) && !newer(v, to)) out.push(part.replace(/^\[[^\]]+\]: .*$/gm, '').trimEnd());
  }
  return out.join('\n\n');
}

// The installed package carries the old changelog, so read the new one from
// the release tag. Best effort: the compare link is printed either way.
async function releaseNotes(repo, from, to) {
  try {
    const base = process.env.SECENV_CHANGELOG_BASE || `https://raw.githubusercontent.com/${repo}`;
    const res = await fetch(`${base}/v${to}/CHANGELOG.md`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return '';
    return changelogBetween(await res.text(), from, to);
  } catch {
    return '';
  }
}

// Updates a global npm install to an exact, explicitly confirmed version: this
// tool sees every secret, so it never updates itself silently.
async function cmdUpdate(args) {
  const { opts, pos } = parseArgs('update', args, { '--check': 'check', '-y': 'yes', '--yes': 'yes' });
  if (pos.length) usageError('update', `unexpected argument: ${pos[0]}`);
  const { check, yes } = opts;
  const pkg = readPackage();
  if (!pkg) {
    die('installed with install.sh: update with "git pull && ./install.sh" in your secenv checkout.');
  }

  let latest;
  try {
    const url = `${REGISTRY}/${pkg.name.replace('/', '%2f')}/latest`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = (await res.json()).version;
    if (typeof latest !== 'string' || !SEMVER.test(latest)) throw new Error(`unexpected version "${latest}"`);
  } catch (e) {
    die(`could not check the latest version: ${e.message}`);
  }

  if (!newer(latest, pkg.version)) {
    console.log(`secenv ${pkg.version} is up to date.`);
    return;
  }
  console.log(`secenv ${pkg.version} -> ${latest}`);
  const repo = pkg.repository?.url?.match(/github\.com\/([^/]+\/[^/.]+)/)?.[1];
  if (repo) {
    const notes = await releaseNotes(repo, pkg.version, latest);
    // Remote text: drop escape sequences and control characters, keep newlines.
    if (notes) console.log(`\n${notes.replace(TERMINAL_CONTROL, '')}\n`);
    console.log(`Changes: https://github.com/${repo}/compare/v${pkg.version}...v${latest}`);
  }
  if (check) return;

  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  const globalRoot = r.status === 0 ? fs.realpathSync(r.stdout.trim()) : null;
  const self = fs.realpathSync(fileURLToPath(import.meta.url));
  if (!globalRoot || !self.startsWith(globalRoot + path.sep)) {
    die(
      `this copy is not a global npm install (${self}).\n` +
        `For npx or a project dependency, change the pinned version to ${latest} where you use it.`,
    );
  }

  if (!yes) {
    if (!process.stdin.isTTY) die('refusing to update without a terminal; add -y');
    if (!(await confirm(`Install ${pkg.name}@${latest}?`))) die('cancelled');
  }
  // --prefer-online: npm's cached metadata can predate a release that the
  // registry check above already sees, and npm then reports ETARGET.
  const install = spawnSync('npm', ['install', '-g', '--ignore-scripts', '--prefer-online', `${pkg.name}@${latest}`], {
    stdio: 'inherit',
  });
  if (install.status !== 0) die('npm install failed');
  refreshBrewCompletion();
  console.log(`✓ secenv ${latest} installed`);
}

// ---------- main ----------

const isMain =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  // `secenv <cmd> --help`: for run only the part before "--" counts, the
  // command after it may well take --help itself.
  const own = cmd === 'run' ? rest.slice(0, rest.indexOf('--') === -1 ? rest.length : rest.indexOf('--')) : rest;
  if (cmd === 'help' || cmd === '-h' || cmd === '--help' || cmd === undefined) help(rest[0]);
  if (own.includes('--help') || own.includes('-h')) help(HELP[cmd] || cmd === 'ls' ? cmd : undefined);
  // Tighten an existing data directory that was created with a wider mode.
  for (const dir of [HOME, STORE]) if (fs.existsSync(dir)) ensureDir(dir);
  switch (cmd) {
    case 'init':
      cmdInit();
      break;
    case '-v':
    case '--version':
    case 'version':
      cmdVersion();
      break;
    case 'update':
      await cmdUpdate(rest);
      break;
    case 'setup':
      await cmdSetup();
      break;
    case 'completion':
      cmdCompletion(rest[0]);
      break;
    case 'skill':
      cmdSkill(rest);
      break;
    case 'set':
      await cmdSet(rest);
      break;
    case 'get':
      cmdGet(rest);
      break;
    case 'rm':
      cmdRm(rest);
      break;
    case 'cp':
      cmdCopyKey(rest, { move: false });
      break;
    case 'mv':
      cmdCopyKey(rest, { move: true });
      break;
    case 'ls':
    case 'list':
      cmdList(rest);
      break;
    case 'import':
      await cmdImport(rest);
      break;
    case 'export':
      cmdExport(rest);
      break;
    case 'profile':
      await cmdProfile(rest);
      break;
    case 'trust':
      cmdTrust(rest);
      break;
    case 'run':
      await cmdRun(rest);
      break;
    default:
      die(`unknown command: ${cmd}\nRun "secenv --help" for the list of commands.`);
  }
}
