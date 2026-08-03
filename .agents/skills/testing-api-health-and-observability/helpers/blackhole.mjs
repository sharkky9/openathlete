import https from 'node:https';
import fs from 'node:fs';
const certDir = process.env.INGEST_CERT_DIR ?? '/tmp/ingest';
const opts = { key: fs.readFileSync(`${certDir}/key.pem`), cert: fs.readFileSync(`${certDir}/cert.pem`) };
// Accepts the request and never responds — forces the shipper's REQUEST_TIMEOUT_MS path.
https.createServer(opts, (req) => { req.resume(); }).listen(8444, '127.0.0.1', () => {
  console.log('blackhole ingest listening on https://127.0.0.1:8444');
});
