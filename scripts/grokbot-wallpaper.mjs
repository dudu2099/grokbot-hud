#!/usr/bin/env node
// Nothing is imported until the Node check passes, so an old Node gets one sentence instead of a stack.
import { nodeProblem } from '../src/runtime.mjs';

function fail(error) {
  import('../src/errors.mjs')
    .then(({ describeUnexpected }) => describeUnexpected(error))
    .catch(() => `出了意料之外的问题：${(error && error.message) || error}`)
    .then((text) => process.stderr.write(`${text}\n`, () => process.exit(1)));
}

const problem = nodeProblem();
if (problem) {
  process.stderr.write(`${problem}\n`, () => process.exit(1));
} else {
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  try {
    // cli.mjs reads the port variables while it loads; a bad value throws here and is reported like any other surprise.
    const { main } = await import('../src/cli.mjs');
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    fail(error);
  }
}
