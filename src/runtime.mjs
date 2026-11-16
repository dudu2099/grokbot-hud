// Kept free of newer syntax so an old Node can still load it and print the one line that says what is wrong.
export var MIN_NODE_MAJOR = 22;

// Returns null when this Node can run the tool, or the sentence to show the user.
export function nodeProblem(version, hasWebSocket) {
  if (version === undefined) version = process.version;
  if (hasWebSocket === undefined) hasWebSocket = typeof globalThis.WebSocket === 'function';
  var shown = String(version).charAt(0) === 'v' ? String(version) : 'v' + version;
  var match = /^v?(\d+)/.exec(String(version));
  var major = match ? Number(match[1]) : 0;
  if (major >= MIN_NODE_MAJOR && hasWebSocket) return null;
  var line = '需要 Node.js ' + MIN_NODE_MAJOR + ' 或更高，你现在是 ' + shown + '。';
  if (major >= MIN_NODE_MAJOR) line += '（这个 Node 里没有全局 WebSocket，可能被启动参数关掉了。）';
  return line;
}
