import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { identifyDebug } from '../src/cdp.mjs';
import { EXIT } from '../src/errors.mjs';
import { openStore } from '../src/store.mjs';
import { EDGE_VERSION, GROK_BOT_VERSION, overlayReport, startFakeDebug } from './fake-cdp.mjs';
import { CLOSED_PORT, runCli, tempDir } from './helpers.mjs';

function withEnv(t, name, value) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

test('identifyDebug tells a closed port, Grok Bot, another program and an allowed stand-in apart', async (t) => {
  withEnv(t, 'GROKBOT_ALLOW_STANDIN', undefined);
  assert.deepEqual(await identifyDebug(Number(CLOSED_PORT)), { state: 'closed', reportedAs: null });

  const grok = await startFakeDebug({ version: GROK_BOT_VERSION });
  t.after(grok.close);
  assert.deepEqual(await identifyDebug(grok.port), { state: 'grokbot', reportedAs: 'Chrome/140.0.0.0' });

  const edge = await startFakeDebug({ version: EDGE_VERSION });
  t.after(edge.close);
  assert.deepEqual(await identifyDebug(edge.port), { state: 'other', reportedAs: 'Edg/142.0.3595.53' });
  // Electron alone is not enough, nor is a GrokBot token without Electron.
  const electronOnly = await startFakeDebug({ version: { Browser: 'Chrome/1', 'User-Agent': 'Mozilla/5.0 Electron/30.0.0' } });
  t.after(electronOnly.close);
  assert.equal((await identifyDebug(electronOnly.port)).state, 'other');

  withEnv(t, 'GROKBOT_ALLOW_STANDIN', '1');
  assert.equal((await identifyDebug(edge.port)).state, 'standin');
});

test('apply and restore against another program on the debug port exit 4 without listing or opening anything', async (t) => {
  const edge = await startFakeDebug({ version: EDGE_VERSION, evaluate: () => overlayReport(3) });
  t.after(edge.close);
  const dir = await tempDir('foreign');
  const env = { GROKBOT_DEBUG_PORT: String(edge.port), GROKBOT_DATA_DIR: dir, GROKBOT_ALLOW_STANDIN: '' };

  let r = await runCli(['apply', 'night-harbor', '--no-daemon'], env);
  assert.equal(r.code, EXIT.notGrokBot, r.stderr);
  assert.match(r.stderr, new RegExp(`127\\.0\\.0\\.1:${edge.port} 上应答的不是 Grok Bot，是别的程序（它自报「Edg/142\\.0\\.3595\\.53」）`));
  r = await runCli(['apply', 'night-harbor', '--relaunch', '--no-daemon'], env);
  assert.equal(r.code, EXIT.notGrokBot, 'a foreign program on the port is never answered with a relaunch');
  r = await runCli(['restore'], env);
  assert.equal(r.code, EXIT.notGrokBot);
  assert.deepEqual([...new Set(edge.log.http)], ['/json/version'], 'only the identity question was asked');
  assert.equal(edge.log.sockets, 0, 'no window was opened');
  assert.equal(await openStore(dir).readLastApplied(), null);
});

test('status reports the debug port as closed, grokbot or other, and names the other program', async (t) => {
  const dir = await tempDir('status-id');
  const grok = await startFakeDebug({ version: GROK_BOT_VERSION });
  const edge = await startFakeDebug({ version: EDGE_VERSION });
  t.after(grok.close);
  t.after(edge.close);
  const status = async (port) => {
    const r = await runCli(['status'], { GROKBOT_DEBUG_PORT: String(port), GROKBOT_DATA_DIR: dir, GROKBOT_ALLOW_STANDIN: '' });
    assert.equal(r.code, 0, r.stderr);
    return { ...JSON.parse(r.stdout), stderr: r.stderr };
  };
  assert.equal((await status(CLOSED_PORT)).debug, 'closed');
  const grokStatus = await status(grok.port);
  assert.equal(grokStatus.debug, 'grokbot');
  assert.equal(grokStatus.stderr, '');
  const edgeStatus = await status(edge.port);
  assert.equal(edgeStatus.debug, 'other');
  assert.equal(edgeStatus.debugReportedAs, 'Edg/142.0.3595.53');
  assert.match(edgeStatus.stderr, /不是 Grok Bot/);
});

test('apply on Grok Bot exits 0 when panels were thinned and 3 (noPanels) with a warning when none were', async (t) => {
  let panels = 2;
  const grok = await startFakeDebug({ version: GROK_BOT_VERSION, evaluate: () => overlayReport(panels) });
  t.after(grok.close);
  const env = { GROKBOT_DEBUG_PORT: String(grok.port), GROKBOT_DATA_DIR: await tempDir('panels') };

  let r = await runCli(['apply', 'night-harbor', '--no-daemon'], env);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(JSON.parse(r.stdout).windows[0].panels, 2);
  assert.ok(grok.log.methods.includes('Runtime.evaluate'));

  panels = 0;
  r = await runCli(['apply', 'night-harbor', '--no-daemon'], env);
  assert.equal(EXIT.noPanels, 3);
  assert.equal(r.code, EXIT.noPanels, r.stderr);
  assert.match(r.stderr, /没有找到任何一块能透出壁纸的面板，你多半看不到壁纸/);
});

// Something that is not our watch on the panel port: it answers 404 to everything and records what it was sent.
async function squatter(t) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.statusCode = 404;
    response.end('not here');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { port: String(server.address().port), seen };
}

test('a foreign program on the panel port is not mistaken for our watch and is never told to quit', async (t) => {
  const other = await squatter(t);
  const dir = await tempDir('owner');
  const startup = await tempDir('owner-startup');
  const env = { GROKBOT_PANEL_PORT: other.port, GROKBOT_DATA_DIR: dir, GROKBOT_STARTUP_DIR: startup };

  let r = await runCli(['status'], env);
  const status = JSON.parse(r.stdout);
  assert.equal(status.panel, false);
  assert.equal(status.panelPortTakenByOther, true);

  r = await runCli(['autostart', 'off'], env);
  assert.equal(r.code, 0, r.stderr);
  const off = JSON.parse(r.stdout);
  assert.equal(off.daemon.stopped, false);
  assert.match(off.daemon.error, /被别的程序占着.*没有向它发退出请求/);
  assert.match(r.stderr, /后台小助手没停/);
  assert.ok(!other.seen.some((line) => line.includes('/api/quit')), JSON.stringify(other.seen));
});

test('after a good apply, a failed autostart and a taken panel port each get a plain line on stderr, exit code unchanged', async (t) => {
  const other = await squatter(t);
  const grok = await startFakeDebug({ version: GROK_BOT_VERSION, evaluate: () => overlayReport(2) });
  t.after(grok.close);
  const dir = await tempDir('daemon-msg');
  // A Startup folder under a plain file cannot be written, so installing autostart fails without touching anything real.
  const blocker = join(dir, 'not-a-folder');
  await writeFile(blocker, 'x');
  const env = { GROKBOT_DEBUG_PORT: String(grok.port), GROKBOT_PANEL_PORT: other.port, GROKBOT_DATA_DIR: dir, GROKBOT_STARTUP_DIR: join(blocker, 'Startup') };

  const r = await runCli(['apply', 'night-harbor'], env);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.daemon.running, false);
  assert.equal(out.daemon.started, false);
  assert.match(out.daemon.error, /被别的程序占着/);
  assert.equal(out.autostart.installed, false);
  assert.match(r.stderr, /登录自启没装上/);
  assert.match(r.stderr, /后台小助手没起来：面板端口 .* 被别的程序占着/);
  assert.ok(!other.seen.some((line) => line.includes('/api/quit')));
});
