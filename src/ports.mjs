export const HOST = '127.0.0.1';

const DEFAULTS = { debug: 19222, panel: 19223 };
export const DEFAULT_DEBUG_PORT = DEFAULTS.debug;
const ENV = { debug: 'GROKBOT_DEBUG_PORT', panel: 'GROKBOT_PANEL_PORT' };

function parsePort(name, raw) {
  if (raw === undefined || raw === '') return DEFAULTS[name];
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${ENV[name]} 必须是 1 到 65535 之间的整数，现在是 "${raw}"`);
  }
  return port;
}

export const PORTS = Object.freeze({
  debug: parsePort('debug', process.env[ENV.debug]),
  panel: parsePort('panel', process.env[ENV.panel]),
});

export const DEBUG_LAUNCH_ARGS = Object.freeze([
  `--remote-debugging-port=${PORTS.debug}`,
  `--remote-debugging-address=${HOST}`,
]);
