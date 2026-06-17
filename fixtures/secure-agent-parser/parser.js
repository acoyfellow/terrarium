export function parsePort(value) {
  const port = Number(value);
  // BUG: accepts fractional and out-of-range ports.
  if (Number.isNaN(port)) throw new Error('invalid port');
  return port;
}
