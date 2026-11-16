import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { psQuote } from '../src/platform/win32.mjs';
import { nodeProblem } from '../src/runtime.mjs';
import { openStore } from '../src/store.mjs';
import { runCli, tempDir } from './helpers.mjs';

const STACK_LINE = /^\s+at .+/m;

test('nodeProblem accepts Node 22 with WebSocket and names the version otherwise', () => {
  assert.equal(nodeProblem('v22.0.0', true), null);
  assert.equal(nodeProblem('v24.1.0', true), null);
  assert.equal(nodeProblem('v20.11.1', true), '需要 Node.js 22 或更高，你现在是 v20.11.1。');
  assert.equal(nodeProblem('18.19.0', false), '需要 Node.js 22 或更高，你现在是 v18.19.0。');
  assert.match(nodeProblem('v22.3.0', false), /^需要 Node.js 22 或更高，你现在是 v22\.3\.0。（这个 Node 里没有全局 WebSocket/);
});

test('without a global WebSocket the entry says which Node is needed and does nothing, even with --relaunch', async () => {
  const dir = await tempDir('entry-node');
  const { code, stdout, stderr } = await runCli(['apply', 'night-harbor', '--relaunch', '--no-daemon'], { GROKBOT_DATA_DIR: dir }, [
    '--import',
    'data:text/javascript,delete globalThis.WebSocket',
  ]);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.equal(stderr.trim(), `需要 Node.js 22 或更高，你现在是 ${process.version}。（这个 Node 里没有全局 WebSocket，可能被启动参数关掉了。）`);
  assert.equal(await openStore(dir).readLastApplied(), null);
});

test('a bad port variable, thrown while the code loads, is one line plus the GROKBOT_DEBUG hint, no stack', async () => {
  const { code, stderr } = await runCli(['status'], { GROKBOT_DEBUG_PORT: 'abc' });
  assert.equal(code, 1);
  assert.match(stderr, /^出了意料之外的问题：GROKBOT_DEBUG_PORT 必须是 1 到 65535 之间的整数，现在是 "abc"\n设环境变量 GROKBOT_DEBUG=1 可以看详细信息。\n$/);
  assert.doesNotMatch(stderr, STACK_LINE);
});

test('an unexpected error inside a command is one line without a stack, and GROKBOT_DEBUG=1 shows the stack', async () => {
  const dir = await tempDir('entry-unexpected');
  // A folder where the state file should be: reading it fails in a way no message was written for.
  await mkdir(join(dir, 'last-applied.json'));
  let r = await runCli(['status'], { GROKBOT_DATA_DIR: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^出了意料之外的问题：EISDIR/);
  assert.match(r.stderr, /设环境变量 GROKBOT_DEBUG=1 可以看详细信息。/);
  assert.doesNotMatch(r.stderr, STACK_LINE);

  r = await runCli(['status'], { GROKBOT_DATA_DIR: dir, GROKBOT_DEBUG: '1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^出了意料之外的问题：EISDIR/);
  assert.match(r.stderr, STACK_LINE);
});

test('psQuote doubles the plain single quote and the four curved ones PowerShell also treats as quotes', () => {
  assert.equal(psQuote("O'Brien"), "'O''Brien'");
  assert.equal(psQuote('O\u2019Brien'), "'O\u2019\u2019Brien'");
  assert.equal(psQuote('a\u2018b\u201Ac\u201Bd'), "'a\u2018\u2018b\u201A\u201Ac\u201B\u201Bd'");
  assert.equal(psQuote('C:\\plain\\path'), "'C:\\plain\\path'");
});

test('PowerShell reads a psQuote-d path with curved quotes back unchanged', { skip: process.platform !== 'win32' }, async () => {
  const value = 'C:\\Users\\O\u2019Brien\\it\u2018s\u201A\u201B \'mine\'\\Grok Bot.exe';
  const source = `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n[Console]::Out.Write(${psQuote(value)})`;
  const out = await new Promise((resolve, reject) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
  assert.equal(out, value);
});
