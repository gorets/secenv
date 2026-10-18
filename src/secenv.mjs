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

const HOME = process.env.SECENV_HOME || path.join(os.homedir(), '.config', 'secenv');
const IDENTITY = path.join(HOME, 'identity.txt');
const RECIPIENT = path.join(HOME, 'recipient.txt');
const STORE = path.join(HOME, 'profiles');
const TRUSTED = path.join(HOME, 'trusted.json');

const USAGE = `secenv — personal secrets encrypted with a Secure Enclave key (Touch ID)

Commands:
  secenv init                         create the Secure Enclave key (once)
  secenv set <profile> KEY [KEY...]   enter secret values (hidden input)
  secenv import <profile> <.env>      import an existing .env file
  secenv list <profile>               print secret names (never values)
  secenv get <profile> KEY            print one secret value (terminal only)
  secenv rm <profile> KEY [KEY...]    remove secrets
  secenv run [<profile>] [--public-env <file>] -- <command...>
                                      run a command with secrets in its environment

The profile for run is optional: it is taken from the SECENV_PROFILE variable
or from the .secenv file in the current directory (one line, the profile name).
--public-env loads NON-secret variables (NODE_ENV, PORT, ...) from a file.

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
}

const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;

function profileFile(name) {
  if (!name || !PROFILE_NAME.test(name)) {
    die('profile name: only letters, digits, dot, hyphen and underscore');
  }
  return path.join(STORE, `${name}.age`);
}

function checkKey(key) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) die(`invalid variable name: ${key}`);
}

function need(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  if (r.error) die(`"${cmd}" not found in PATH. Run install.sh or install it manually.`);
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
      val = val
        .slice(1, val.lastIndexOf('"'))
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (val.startsWith("'") && val.lastIndexOf("'") > 0) {
      val = val.slice(1, val.lastIndexOf("'"));
    } else {
      val = val.replace(/\s+#.*$/, '').trim();
    }
    out[key] = val;
  }
  return out;
}

// ---------- age helpers ----------

function readRecipient() {
  if (!fs.existsSync(RECIPIENT)) die('key not created. Run: secenv init');
  return fs.readFileSync(RECIPIENT, 'utf8').trim();
}

function encryptTo(file, plaintext) {
  const r = spawnSync('age', ['-r', readRecipient()], {
    input: plaintext,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (r.status !== 0) die('could not encrypt (age returned an error)');
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, r.stdout, { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic replace
}

function decryptFrom(file) {
  need('age');
  const r = spawnSync('age', ['-d', '-i', IDENTITY, file], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
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
    r = spawnSync('age-keygen', ['-o', IDENTITY], { stdio: ['ignore', 'inherit', 'inherit'] });
  } else {
    need('age-plugin-se');
    r = spawnSync(
      'age-plugin-se',
      ['keygen', '--access-control=any-biometry', '-o', IDENTITY],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
  }
  if (r.status !== 0) die('could not create the key');
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
  let [name, key] = pos;
  if (pos.length === 1 && name.includes('/')) {
    // <profile>/KEY shorthand; profile names cannot contain a slash
    const i = name.lastIndexOf('/');
    key = name.slice(i + 1);
    name = name.slice(0, i);
  } else if (pos.length !== 2) {
    die('usage: secenv get <profile> KEY  (or <profile>/KEY)');
  }
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
  const data = loadProfile(name, { mustExist: true });
  for (const k of keys) delete data[k];
  saveProfile(name, data);
  console.log(`Removed: ${keys.join(', ')}`);
}

// The profile in ./.secenv decides which secrets the launched code receives, so
// a cloned repository must not make that choice silently. The "directory ->
// profile" binding is remembered after explicit confirmation.
async function trustedProjectProfile() {
  const file = path.resolve('.secenv');
  if (!fs.existsSync(file)) return undefined;
  const profile = fs.readFileSync(file, 'utf8').trim();
  // Validate before the name reaches any prompt or message: the file comes from
  // the repository, so it must not be able to inject text into the question.
  if (!PROFILE_NAME.test(profile)) die(`invalid profile name in ${file}`);
  const dir = fs.realpathSync(path.dirname(file));
  let trusted = {};
  try {
    trusted = JSON.parse(fs.readFileSync(TRUSTED, 'utf8'));
  } catch {}
  if (trusted[dir] === profile) return profile;

  if (!process.stdin.isTTY) {
    die(`${dir}/.secenv selects profile "${profile}", but it is not confirmed. Run secenv run in a terminal or pass the profile as an argument.`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) =>
    rl.question(`Project ${dir} requests profile "${profile}". Allow? [y/N] `, resolve),
  );
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) die('cancelled');
  trusted[dir] = profile;
  ensureDir(HOME);
  fs.writeFileSync(TRUSTED, JSON.stringify(trusted, null, 2), { mode: 0o600 });
  return profile;
}

async function cmdRun(args) {
  const sep = args.indexOf('--');
  if (sep === -1 || sep === args.length - 1) die('usage: secenv run [<profile>] -- <command...>');
  const head = args.slice(0, sep);
  const cmd = args.slice(sep + 1);

  let profile;
  let envFile;
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '--public-env') {
      envFile = head[++i];
      if (!envFile) die('--public-env requires a file');
    } else if (!profile) profile = head[i];
    else die(`unexpected argument: ${head[i]}`);
  }
  if (!profile) profile = process.env.SECENV_PROFILE;
  if (!profile) profile = await trustedProjectProfile();
  if (!profile) die('no profile specified (argument, SECENV_PROFILE or .secenv file)');

  if (envFile && !fs.existsSync(envFile)) die(`--public-env: file not found: ${envFile}`);
  const plain = envFile ? parseDotenv(fs.readFileSync(envFile, 'utf8')) : {};
  const secrets = loadProfile(profile, { mustExist: true });
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

// ---------- main ----------

const isMain =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'init':
      cmdInit();
      break;
    case 'set':
      await cmdSet(rest[0], rest.slice(1));
      break;
    case 'import':
      cmdImport(rest[0], rest[1]);
      break;
    case 'list':
      cmdList(rest[0]);
      break;
    case 'get':
      cmdGet(rest);
      break;
    case 'rm':
      cmdRm(rest[0], rest.slice(1));
      break;
    case 'run':
      await cmdRun(rest);
      break;
    default:
      process.stdout.write(USAGE);
      process.exit(cmd && cmd !== '-h' && cmd !== '--help' ? 1 : 0);
  }
}
