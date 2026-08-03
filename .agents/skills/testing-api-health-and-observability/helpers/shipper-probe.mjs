// Exercises the compiled shipper + logger from apps/api/dist
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const base =
  process.env.OA_API_DIST ??
  new URL('../../../../apps/api/dist/common/logging', import.meta.url).pathname;

const { BetterStackLogShipper } = await import(`${base}/better-stack.shipper.js`);
const { BetterStackLogger } = await import(`${base}/better-stack.logger.js`);

// ---------- 1) buffer cap under a slow ingest ----------
const shipper = new BetterStackLogShipper({
  sourceToken: 'probe-token',
  ingestingHost: '127.0.0.1:8443',
  environment: 'production',
  service: 'probe',
});

const TOTAL = 5000;
for (let i = 0; i < TOTAL; i++) {
  shipper.enqueue({
    dt: new Date().toISOString(),
    level: 'info',
    message: `probe event ${i}`,
    context: 'Probe',
  });
}
console.log(`enqueued ${TOTAL} events synchronously`);
console.log(`buffer length right after burst: ${shipper.buffer.length} (MAX_BUFFER_SIZE is 1000)`);

await new Promise((r) => setTimeout(r, 6000));
console.log(`buffer length after 6s of slow ingest: ${shipper.buffer.length}`);
const oldest = shipper.buffer[0]?.message;
const newest = shipper.buffer[shipper.buffer.length - 1]?.message;
console.log(`oldest buffered: ${oldest} | newest buffered: ${newest}`);

// ---------- 2) logger must not ship stack:"undefined" ----------
const captured = [];
const stub = { enqueue: (e) => captured.push(e) };
const logger = new BetterStackLogger(stub);
logger.setContext?.('ProbeCtx');
logger.log('plain info with context', 'MyContext');
logger.error('error without a stack', undefined, 'MyContext');
logger.warn('warn with no extras');
logger.error('error with a stack', 'Error: boom\n    at probe', 'MyContext');
logger.error(new Error('real error object'));
console.log('--- logger events ---');
for (const e of captured) {
  console.log(JSON.stringify({ level: e.level, message: String(e.message).slice(0, 40), context: e.context, stack: e.stack === undefined ? '<undefined-field>' : e.stack.slice(0, 40) }));
}
const bad = captured.filter((e) => e.stack === 'undefined');
console.log(`events shipping the literal string "undefined" as stack: ${bad.length}`);
process.exit(0);
