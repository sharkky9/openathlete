import https from 'node:https';
import fs from 'node:fs';
const opts = { key: fs.readFileSync('/tmp/ingest/key.pem'), cert: fs.readFileSync('/tmp/ingest/cert.pem') };
// Accepts the request and never responds — forces the shipper's REQUEST_TIMEOUT_MS path.
https.createServer(opts, (req) => { req.resume(); }).listen(8444, '127.0.0.1', () => {
  console.log('blackhole ingest listening on https://127.0.0.1:8444');
});
