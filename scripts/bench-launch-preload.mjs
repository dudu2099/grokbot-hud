// Loaded with --import by scripts/bench-launch.mjs only. It times every PowerShell run and, the moment launch is about
// to start Grok Bot (a spawn of the exe in GBT_BENCH_FAKE_APP), prints the time and exits instead, so nothing starts.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const fakeApp = process.env.GBT_BENCH_FAKE_APP;
const t0 = Number(process.env.GBT_BENCH_T0);
const say = (line) => process.stderr.write(`BENCH ${line}\n`);
say(`node-start ${Date.now() - t0}`);

const label = (args) => {
  const index = args.indexOf('-EncodedCommand');
  const script = index >= 0 ? Buffer.from(args[index + 1], 'base64').toString('utf16le') : args.join(' ');
  return script.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim().slice(0, 70);
};

const originalExecFile = childProcess.execFile;
const originalAsync = originalExecFile[promisify.custom];
function timedAsync(file, args, ...rest) {
  const started = Date.now();
  return originalAsync(file, args, ...rest).finally(() => say(`ps ${Date.now() - started} ${label(args)}`));
}
function execFile(...args) {
  return originalExecFile(...args);
}
execFile[promisify.custom] = timedAsync;
childProcess.execFile = execFile;

const originalSpawn = childProcess.spawn;
childProcess.spawn = (file, ...rest) => {
  if (fakeApp && file === fakeApp) {
    say(`launch ${Date.now() - t0}`);
    process.exit(0);
  }
  return originalSpawn(file, ...rest);
};
syncBuiltinESMExports();
