// Exit codes. Each one means one thing, so scripts and the AI helper can tell outcomes apart.
export const EXIT = Object.freeze({
  ok: 0,
  // Anything else that went wrong; the message says what.
  error: 1,
  // The debug port is closed and --relaunch was not given; Grok Bot was not touched.
  debugClosed: 2,
  // The wallpaper went in, but no window had a single panel thinned out, so it is most likely not visible.
  noPanels: 3,
  // Something other than Grok Bot answers on the debug port; nothing was injected.
  notGrokBot: 4,
});

export class UserError extends Error {
  constructor(message, exit = EXIT.error) {
    super(message);
    this.name = 'UserError';
    this.exit = exit;
  }
}

export const DEBUG_ENV = 'GROKBOT_DEBUG';

// One readable line for an error nobody planned for; the stack only when the user asks for it.
export function describeUnexpected(error, debug = process.env[DEBUG_ENV] === '1') {
  const message = (error && typeof error === 'object' && 'message' in error ? error.message : String(error)) || String(error);
  const lines = [`出了意料之外的问题：${message}`];
  if (debug) lines.push(error?.stack ?? String(error));
  else lines.push(`设环境变量 ${DEBUG_ENV}=1 可以看详细信息。`);
  return lines.join('\n');
}
