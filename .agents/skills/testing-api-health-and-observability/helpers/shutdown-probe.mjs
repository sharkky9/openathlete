process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const base = '/home/ubuntu/repos/openathlete/apps/api/dist/common/logging';
const { BetterStackLogShipper } = await import(`${base}/better-stack.shipper.js`);

const scenario = process.argv[2];
const host = process.argv[3];

const shipper = new BetterStackLogShipper({
  sourceToken: 'probe-token',
  ingestingHost: host,
  environment: 'production',
  service: 'probe',
});

const fill = (n, tag) => {
  for (let i = 0; i < n; i++) {
    shipper.enqueue({ dt: new Date().toISOString(), level: 'info', message: `${tag} ${i}`, context: 'Probe' });
  }
};

// Fill the buffer to its 1000-event cap.
fill(3000, 'preload');
console.log(`scenario=${scenario} host=${host}`);
console.log(`buffer before shutdown: ${shipper.buffer.length}`);

let flooder = null;
if (scenario === 'flood') {
  // Simulate the API still logging while the signal handler drains: pre-fix this
  // refilled the buffer as fast as it drained and stalled shutdown.
  flooder = setInterval(() => fill(200, 'during-shutdown'), 50);
}

const t0 = Date.now();
await shipper.shutdown();
const elapsed = Date.now() - t0;
if (flooder) clearInterval(flooder);

console.log(`shutdown() resolved after ${elapsed} ms`);
console.log(`buffer after shutdown: ${shipper.buffer.length}`);
console.log(`stopped flag: ${shipper.stopped}`);
// Bound: 10 batches x REQUEST_TIMEOUT_MS(5000) = 50s worst case.
console.log(elapsed <= 60000 ? 'RESULT: terminated within the bounded window (PASS)' : 'RESULT: exceeded bound (FAIL)');
process.exit(0);
