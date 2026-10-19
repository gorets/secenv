---
name: secenv
description: Use when a project's .env holds secenv://<profile>/NAME references, a script or package.json calls `secenv run`, a secret must be added, checked or rotated, or a command fails with an unset API key, a 401, "not trusted in … no terminal to ask", or a literal secenv:// value reaching the app.
---

# Working with secenv

## Overview

secenv keeps a developer's secrets encrypted on their Mac, with the key in the Secure Enclave. **Every decryption asks the human to touch Touch ID.** You never see or handle secret values. You run commands through `secenv run`, and the person at the keyboard provides the fingerprint.

## How a project uses it

```
# .env, committed
OPENAI_API_KEY=secenv://myai/OPENAI_API_KEY   # resolved by secenv run
MODEL=gpt-4.1                                 # plain value, passed as is
```

`secenv run -- <cmd>` reads `./.env`, swaps each `secenv://profile/NAME` for the secret, and starts `<cmd>` with them in its environment. Started without secenv, the app gets the literal `secenv://…` string, and providers answer 401.

## Quick reference

| Task | Command | Touch ID |
|---|---|---|
| Run anything that needs secrets | `secenv run -- npm run check` | yes |
| List profiles | `secenv ls` | no |
| Key names and change dates in a profile | `secenv ls myai` (a pipe gets names only; the masked previews are for the human's terminal) | yes |
| Keys not rotated for 90 days | `secenv ls myai --older-than 90d` | yes |
| Check a key without printing it | `secenv run -- node -e 'const k=process.env.OPENAI_API_KEY||""; console.log(!k ? "missing" : k.startsWith("secenv://") ? "unresolved" : "set, length " + k.length)'` | yes |
| Pass a secret as a CLI flag | `secenv run -- sh -c 'node seed.mjs --api-key "$OPENAI_API_KEY"'` (single quotes) | yes |
| Directories trusted to use a profile | `secenv trust ls` | no |
| Details of any command | `secenv <command> --help` | no |

## Rules

1. **Batch Touch ID.** Each `secenv run` is one fingerprint from the human. Before a run, say what you are about to run. Put repetition inside one run: `secenv run -- sh -c 'for i in 1 2 3 4 5; do npm test || echo "run $i failed"; done'`. Combine checks the same way (`sh -c 'npm test && npm run check'`). Never loop or retry `secenv run` itself.
2. **The human stores secrets, not you.** To add or change one, add the reference line to `.env` and make sure the scripts that need it start with `secenv run --`. Then ask the human to run `secenv set <profile>/<NAME>` in their own terminal: input is hidden there. If they pasted a value into the chat, don't put it in a command; tell them it is now in the transcript and should be rotated at the provider.
3. **Trust prompts are theirs.** `not trusted in <dir> and there is no terminal to ask` means the first use of that profile in that directory needs a yes from the human. Ask them to run the same command once in their terminal. Don't fake a TTY, edit `~/.config/secenv/trusted.json`, or pipe answers.
4. **Values never leave the process.** No `secenv get`, no `--allow-pipe`, no `secenv export`, no printing `process.env` secrets. Check presence and length only. Key names and dates from `secenv ls` are fine to show.
5. **One profile per project.** Put new keys in the profile the project's `.env` already uses, whatever its name suggests: a profile is a project's set of secrets, not a provider's. References to several profiles work, but cost one Touch ID per profile on every run.

## Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| 401, or the key check says `unresolved` | Started without secenv | Prefix with `secenv run --`, or put it in the npm script |
| 401, but the key check says `set` | Stored value is wrong or revoked | Ask the human to rotate it and run `secenv set <profile>/<NAME>` |
| `not found in profile "myai": NAME` | Reference added, value never stored | Ask the human to run `secenv set myai/NAME` |
| `"age" not found in /opt/homebrew/bin, …` | Tools not installed | Ask the human to run `secenv setup` |
| `secenv: ignoring PATH from .env` | `.env` tried to set `PATH`, `NODE_OPTIONS`, `DYLD_*` | Intended; set those outside `.env` |
| `node --env-file=.env` in a script | Harmless under secenv: Node keeps variables already set | Leave it, or drop the flag |
