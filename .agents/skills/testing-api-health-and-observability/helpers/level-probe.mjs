const base = '/home/ubuntu/repos/openathlete/apps/api/dist/common/logging';
const { BetterStackLogger } = await import(`${base}/better-stack.logger.js`);

const run = (label, levels) => {
  const captured = [];
  const logger = new BetterStackLogger({ enqueue: (e) => captured.push(e) });
  logger.setContext('Probe');
  if (levels) logger.setLogLevels(levels);
  logger.log('a log record');
  logger.warn('a warn record');
  logger.error('an error record');
  logger.debug('a debug record');
  logger.verbose('a verbose record');
  logger.fatal('a fatal record');
  console.log(`\n=== ${label} (logLevels=${levels ? levels.join(',') : 'default'}) ===`);
  console.log('shipped levels:', captured.map((e) => e.level).join(', ') || '(none)');
  return captured.map((e) => e.level);
};

const all = run('all levels enabled', null);
const restricted = run('debug/verbose disabled', ['log', 'warn', 'error', 'fatal']);

console.log('\n--- assertions ---');
console.log(`debug shipped when enabled : ${all.includes('debug')}`);
console.log(`trace(verbose) when enabled: ${all.includes('trace')}`);
console.log(`debug shipped when DISABLED: ${restricted.includes('debug')}   (must be false)`);
console.log(`trace shipped when DISABLED: ${restricted.includes('trace')}   (must be false)`);
console.log(`info/warn/error still shipped: ${['info', 'warn', 'error'].every((l) => restricted.includes(l))}   (must be true)`);
