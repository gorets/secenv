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
const REGISTRY = (process.env.SECENV_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');

const USAGE = `secenv — personal secrets encrypted with a Secure Enclave key (Touch ID)

Commands:
  secenv setup                        install age + age-plugin-se, create the key, set up completion
  secenv init                         create the Secure Enclave key (once)
  secenv completion zsh               print the zsh completion script
  secenv update [--check] [--yes]     update a global npm install (asks to confirm)
  secenv --version                    print the installed version
  secenv set <profile> KEY [KEY...]   enter secret values (hidden input)
  secenv import <profile> <.env>      import an existing .env file
  secenv profile ls                   list profiles
  secenv profile rm <name> [--yes]    delete a profile (asks to confirm)
  secenv profile mv <old> <new>       rename a profile
  secenv profile cp <src> <dst>       copy a profile
  secenv profile export <name>        print a profile in .env format (terminal only)
  secenv profile trust ls|rm|prune    manage which directories may use which profiles
  secenv list <profile>               print secret names (never values)
  secenv get <profile> KEY            print one secret value (terminal only)
  secenv rm <profile> KEY [KEY...]    remove secrets
  secenv run [<profile>] [--public-env <file>] -- <command...>
                                      run a command with secrets in its environment

profile ls, rm, mv and cp work on files only: no Touch ID needed. profile export
decrypts (Touch ID) and, like get, refuses to write into a pipe or file unless
you add --allow-pipe.

set, get and rm also accept <profile>/KEY (secenv set myapp/OPENAI_API_KEY).
run accepts one or more <profile>/KEY items to pass only those secrets:
  secenv run myapp/OPENAI_API_KEY myapp/STRIPE_KEY -- node app.js

The profile for run is optional: it is taken from the SECENV_PROFILE variable
or from the .secenv file in the current directory (one line, the profile name).
The first run of a profile in a directory asks for approval, however the profile
was named; approvals are stored per directory (secenv profile trust ls).
--public-env loads NON-secret variables (NODE_ENV, PORT, ...) from a file;
PATH, NODE_OPTIONS, NODE_PATH, DYLD_* and LD_* in it are ignored.

get refuses to write into a pipe or $(...) unless you add --allow-pipe: a secret
passed as a command-line argument is visible to every process via ps. Prefer
run, which hands secrets to the child through its environment.
`;

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
const UNSAFE_PUBLIC_ENV = /^(PATH|NODE_OPTIONS|NODE_PATH|DYLD_.*|LD_.*)$/;
// CSI and OSC sequences, then any remaining control character except newline.
const TERMINAL_CONTROL = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x09\x0b-\x1f\x7f]/g;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function profileFile(name) {
  if (!name || !PROFILE_NAME.test(name) || name === '.' || name === '..') {
    die('profile name: only letters, digits, dot, hyphen and underscore');
  }
  return path.join(STORE, `${name}.age`);
}

function checkKey(key) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) die(`invalid variable name: ${key}`);
}

// Accepts both `<profile> KEY [KEY...]` and the `<profile>/KEY [KEY...]`
// shorthand; profile names cannot contain a slash, so the split is unambiguous.
function splitProfileKeys(args) {
  const [first = '', ...rest] = args;
  const i = first.lastIndexOf('/');
  if (i === -1) return { name: first, keys: rest };
  return { name: first.slice(0, i), keys: [first.slice(i + 1), ...rest] };
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

export function formatDotenv(data) {
  const quote = (v) =>
    `"${v.replace(/[\\"\n\r]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r' })[c])}"`;
  return Object.keys(data)
    .sort()
    .map((k) => `${k}=${quote(String(data[k]))}\n`)
    .join('');
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

function loadProfile(name, { mustExist = false } = {}) {
  const file = profileFile(name);
  if (!fs.existsSync(file)) {
    if (mustExist) die(`profile "${name}" not found. Create it: secenv set ${name} KEY`);
    return {};
  }
  try {
    return JSON.parse(decryptFrom(file));
  } catch {
    die('profile contents are corrupted');
  }
}

function saveProfile(name, data) {
  encryptTo(profileFile(name), JSON.stringify(data));
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
  console.log('Next: secenv set <profile> KEY [KEY...]');
}

async function cmdSet(name, keys) {
  if (!keys.length) die('specify secret names: secenv set <profile> KEY [KEY...]');
  keys.forEach(checkKey);
  const data = loadProfile(name);
  for (const k of keys) data[k] = await promptHidden(`${k}: `, keys.length);
  saveProfile(name, data);
  console.log(`Saved to profile "${name}": ${keys.join(', ')}`);
}

function cmdImport(name, file) {
  if (!file || !fs.existsSync(file)) die('specify an existing .env file');
  const incoming = parseDotenv(fs.readFileSync(file, 'utf8'));
  const keys = Object.keys(incoming);
  if (!keys.length) die('no variables found in the file');
  const data = { ...loadProfile(name), ...incoming };
  saveProfile(name, data);
  console.log(`Imported ${keys.length} variables into profile "${name}".`);
  console.log(`Now delete the source file (rm ${file}) and rotate any keys that were in it.`);
}

// Reads file names only, so no decryption and no Touch ID.
function cmdProfiles() {
  let files = [];
  try {
    files = fs.readdirSync(STORE);
  } catch {}
  const names = files.filter((f) => f.endsWith('.age')).map((f) => f.slice(0, -4)).sort();
  if (!names.length) {
    process.stderr.write('No profiles yet. Create one: secenv set <profile> KEY\n');
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
    .filter(([, list]) => list.includes(name))
    .map(([dir]) => dir);
}

async function cmdProfileRm(name, yes) {
  const file = existingProfileFile(name);
  if (!yes) {
    if (!process.stdin.isTTY) die('refusing to delete without a terminal; add --yes');
    if (!(await confirm(`Delete profile "${name}" and all its secrets? This cannot be undone.`))) die('cancelled');
  }
  fs.unlinkSync(file);
  // Drop approvals for the deleted profile, so a profile recreated later under
  // the same name is not silently trusted by old projects.
  const trusted = readTrusted();
  const dirs = trustedDirsFor(name);
  if (dirs.length) {
    for (const dir of dirs) {
      trusted[dir] = trusted[dir].filter((p) => p !== name);
      if (!trusted[dir].length) delete trusted[dir];
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
function cmdProfileExport(name, { allowPipe, out }) {
  existingProfileFile(name);
  if (!out && !process.stdout.isTTY && !allowPipe) {
    die(
      'refusing to write plaintext secrets into a pipe. ' +
        'To write a file use --out <file> (created with mode 0600); ' +
        'if you really need a pipe, add --allow-pipe.',
    );
  }
  const data = loadProfile(name, { mustExist: true });
  const text = formatDotenv(data);
  if (out) {
    // A shell redirect would use the umask (usually 0644); open the file here.
    try {
      fs.writeFileSync(out, text, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      die(e.code === 'EEXIST' ? `${out} already exists` : `could not write ${out}: ${e.message}`);
    }
    process.stderr.write(`Wrote ${Object.keys(data).length} secrets from "${name}" to ${out} in plaintext (mode 0600). Delete it after use.\n`);
    return;
  }
  process.stdout.write(text);
  if (!process.stdout.isTTY) {
    process.stderr.write(`Exported ${Object.keys(data).length} secrets from "${name}" in plaintext. Delete the output after use.\n`);
  }
}

// Approvals of project .secenv files (directory -> profile), see trustedProjectProfile.
function cmdTrustLs(profile) {
  const entries = Object.entries(readTrusted())
    .filter(([, list]) => !profile || list.includes(profile))
    .sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    process.stderr.write('No approved directories.\n');
    return;
  }
  for (const [dir, list] of entries) {
    const gone = !fs.existsSync(dir);
    console.log(`${dir}  ->  ${list.join(', ')}${gone ? '  (directory gone, run: secenv profile trust prune)' : ''}`);
  }
}

function cmdTrustRm(target) {
  const trusted = readTrusted();
  let dir = path.resolve(target);
  if (!(dir in trusted) && fs.existsSync(dir)) dir = fs.realpathSync(dir);
  if (!(dir in trusted)) die(`no approval for ${dir}`);
  const list = trusted[dir];
  delete trusted[dir];
  writeTrusted(trusted);
  console.log(`Revoked: ${dir} can no longer use ${list.map((p) => `"${p}"`).join(', ')} without asking.`);
}

// Drops approvals whose directory is gone, so a different project cloned into
// the same path later is asked again.
function cmdTrustPrune() {
  const trusted = readTrusted();
  const gone = Object.keys(trusted).filter((dir) => !fs.existsSync(dir));
  gone.forEach((dir) => delete trusted[dir]);
  if (gone.length) writeTrusted(trusted);
  console.log(gone.length ? `Removed ${gone.length} stale approval(s):\n  ${gone.join('\n  ')}` : 'Nothing to prune.');
}

const PROFILE_USAGE = `usage:
  secenv profile ls                   list profiles
  secenv profile rm <name> [--yes]    delete a profile
  secenv profile mv <old> <new>       rename a profile
  secenv profile cp <src> <dst>       copy a profile
  secenv profile export <name> [--out <file>] [--allow-pipe]
                                      print a profile in .env format (Touch ID);
                                      --out writes a 0600 file instead
  secenv profile trust ls [<profile>] list directories approved to use a profile
  secenv profile trust rm <dir>       revoke a directory's approvals
  secenv profile trust prune          remove approvals of deleted directories`;

async function cmdProfile(args) {
  const [action, ...rest] = args;
  const yes = rest.includes('--yes');
  const allowPipe = rest.includes('--allow-pipe');
  let out;
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--yes' || rest[i] === '--allow-pipe') continue;
    if (rest[i] === '--out') {
      out = rest[++i];
      if (!out) die('--out requires a file');
    } else pos.push(rest[i]);
  }
  const needArgs = (n) => {
    if (pos.length !== n) die(PROFILE_USAGE);
  };
  switch (action) {
    case 'ls':
    case 'list':
      needArgs(0);
      return cmdProfiles();
    case 'rm':
      needArgs(1);
      return cmdProfileRm(pos[0], yes);
    case 'mv':
      needArgs(2);
      return cmdProfileMv(pos[0], pos[1]);
    case 'cp':
      needArgs(2);
      return cmdProfileCp(pos[0], pos[1]);
    case 'export':
      needArgs(1);
      return cmdProfileExport(pos[0], { allowPipe, out });
    case 'trust': {
      const [sub, ...targs] = pos;
      if (sub === 'ls' && targs.length <= 1) return cmdTrustLs(targs[0]);
      if (sub === 'rm' && targs.length === 1) return cmdTrustRm(targs[0]);
      if (sub === 'prune' && !targs.length) return cmdTrustPrune();
      die(PROFILE_USAGE);
    }
    default:
      die(PROFILE_USAGE);
  }
}

function cmdList(name) {
  const data = loadProfile(name, { mustExist: true });
  Object.keys(data).sort().forEach((k) => console.log(k));
}

function cmdGet(args) {
  let allowPipe = false;
  const pos = [];
  for (const a of args) {
    if (a === '--allow-pipe') allowPipe = true;
    else pos.push(a);
  }
  const { name, keys } = splitProfileKeys(pos);
  if (keys.length !== 1) die('usage: secenv get <profile> KEY  (or <profile>/KEY)');
  const [key] = keys;
  checkKey(key);
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
  process.stdout.write(process.stdout.isTTY ? `${data[key]}\n` : data[key]);
}

function cmdRm(name, keys) {
  if (!keys.length) die('specify secret names to remove');
  keys.forEach(checkKey);
  const data = loadProfile(name, { mustExist: true });
  for (const k of keys) delete data[k];
  saveProfile(name, data);
  console.log(`Removed: ${keys.join(', ')}`);
}

// The profile in ./.secenv decides which secrets the launched code receives, so
// a cloned repository must not make that choice silently. The "directory ->
// profile" binding is remembered after explicit confirmation.
// trusted.json: { "<realpath of directory>": ["profile", ...] }. Older files
// stored a single string per directory; both shapes are read.
function readTrusted() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(TRUSTED, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [dir, v] of Object.entries(raw)) {
    const list = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && PROFILE_NAME.test(x));
    if (list.length) out[dir] = list;
  }
  return out;
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
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
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
// neither the profile nor the command.
async function approveRun(profile, source, cmd) {
  const dir = fs.realpathSync(process.cwd());
  const trusted = readTrusted();
  if (trusted[dir]?.includes(profile)) return;

  const question =
    `secenv: first use of profile "${profile}" (${source}) in ${dir}\n` +
    `  command: ${cmd.join(' ')}\n` +
    `Allow this directory to use "${profile}" from now on?`;
  const ok = await confirm(question);
  if (ok === null) {
    die(
      `profile "${profile}" (${source}) is not approved for ${dir} and there is no terminal to ask. ` +
        'Run it once interactively.',
    );
  }
  if (!ok) die('cancelled');
  trusted[dir] = [...(trusted[dir] ?? []), profile];
  writeTrusted(trusted);
}

async function cmdRun(args) {
  const sep = args.indexOf('--');
  if (sep === -1 || sep === args.length - 1) die('usage: secenv run [<profile>] -- <command...>');
  const head = args.slice(0, sep);
  const cmd = args.slice(sep + 1);

  let profile;
  let envFile;
  // `<profile>/KEY` items limit the child to the listed secrets only.
  let only = null;
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '--public-env') {
      envFile = head[++i];
      if (!envFile) die('--public-env requires a file');
    } else if (head[i].includes('/')) {
      const { name, keys } = splitProfileKeys([head[i]]);
      if (profile && only === null) die(`unexpected argument: ${head[i]}`);
      if (profile && profile !== name) die(`all <profile>/KEY items must use one profile: ${head[i]}`);
      checkKey(keys[0]);
      profile = name;
      (only ??= []).push(keys[0]);
    } else if (!profile) profile = head[i];
    else die(`unexpected argument: ${head[i]}`);
  }
  let source = 'argument';
  if (!profile && process.env.SECENV_PROFILE) {
    profile = process.env.SECENV_PROFILE;
    source = 'SECENV_PROFILE';
  }
  if (!profile) {
    profile = projectProfile();
    source = '.secenv';
  }
  if (!profile) die('no profile specified (argument, SECENV_PROFILE or .secenv file)');
  profileFile(profile); // validate the name before it is shown anywhere
  await approveRun(profile, source, cmd);
  // The Touch ID dialog carries no context; this line is what the user can check.
  process.stderr.write(`secenv: ${profile}${only ? '/' + only.join(',') : ''} (${source}) -> ${cmd.join(' ')}\n`);

  if (envFile && !fs.existsSync(envFile)) die(`--public-env: file not found: ${envFile}`);
  const plain = envFile ? parseDotenv(fs.readFileSync(envFile, 'utf8')) : {};
  // A public env file may come from the repository; it must not decide which
  // binary runs or what gets loaded into it.
  const dropped = Object.keys(plain).filter((k) => UNSAFE_PUBLIC_ENV.test(k));
  for (const k of dropped) delete plain[k];
  if (dropped.length) process.stderr.write(`secenv: ignoring ${dropped.join(', ')} from ${envFile}\n`);
  let secrets = loadProfile(profile, { mustExist: true });
  if (only) {
    const missing = only.filter((k) => !(k in secrets));
    if (missing.length) die(`not found in profile "${profile}": ${missing.join(', ')}`);
    secrets = Object.fromEntries(only.map((k) => [k, secrets[k]]));
  }
  const env = { ...process.env, ...plain, ...secrets };

  const child = spawn(cmd[0], cmd.slice(1), { env, stdio: 'inherit' });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => child.kill(sig));
  }
  child.on('error', (e) => die(`could not start "${cmd[0]}": ${e.message}`));
  child.on('exit', (code, signal) => {
    // Conventional shell exit code for a signal death; re-raising the signal
    // would hit our own forwarding handler above and exit with 0.
    if (signal) process.exit(128 + (os.constants.signals[signal] ?? 0));
    else process.exit(code ?? 1);
  });
}

// ---------- setup ----------

function cmdCompletion(shell) {
  if (shell !== 'zsh') die('usage: secenv completion zsh   (only zsh is supported)');
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
  const check = args.includes('--check');
  const yes = args.includes('--yes');
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
    if (!process.stdin.isTTY) die('refusing to update without a terminal; add --yes');
    if (!(await confirm(`Install ${pkg.name}@${latest}?`))) die('cancelled');
  }
  const install = spawnSync('npm', ['install', '-g', '--ignore-scripts', `${pkg.name}@${latest}`], { stdio: 'inherit' });
  if (install.status !== 0) die('npm install failed');
  refreshBrewCompletion();
  console.log(`✓ secenv ${latest} installed`);
}

// ---------- main ----------

const isMain =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
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
    case 'set': {
      const { name, keys } = splitProfileKeys(rest);
      await cmdSet(name, keys);
      break;
    }
    case 'import':
      cmdImport(rest[0], rest[1]);
      break;
    // `profile <action>` is the canonical form; bare `profiles` means `profile ls`.
    case 'profile':
    case 'profiles':
      await cmdProfile(cmd === 'profiles' && !rest.length ? ['ls'] : rest);
      break;
    case 'list':
      if (!rest[0]) die('specify a profile: secenv list <profile>  (all profiles: secenv profile ls)');
      cmdList(rest[0]);
      break;
    case 'get':
      cmdGet(rest);
      break;
    case 'rm': {
      const { name, keys } = splitProfileKeys(rest);
      cmdRm(name, keys);
      break;
    }
    case 'run':
      await cmdRun(rest);
      break;
    default:
      process.stdout.write(USAGE);
      process.exit(cmd && cmd !== '-h' && cmd !== '--help' ? 1 : 0);
  }
}
