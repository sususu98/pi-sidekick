// Preloaded into every offline PoC subprocess. PI_OFFLINE alone does not block inference.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
function blocked() {
  fs.appendFileSync(process.env.FUSION_PROOF_ROOT + '/network-attempts.log', 'blocked outbound request\n');
  throw new Error('Offline PoC forbids network');
}
globalThis.fetch = blocked;
http.request = http.get = https.request = https.get = blocked;
if (process.env.TEST_FAIL_FINAL_APPEND === '1') {
  const append = fs.appendFileSync;
  fs.appendFileSync = function(path, data, ...options) {
    const text = String(data);
    if (text.includes('"customType":"pi-sidekick.checkpoint.v1"') && text.includes('"status":"idle"') && text.includes('"tasks":1')) {
      fs.writeFileSync(process.env.FUSION_PROOF_ROOT + '/append-failure.log', 'injected after native in-memory mutation');
      const error = new Error('injected checkpoint ENOSPC'); error.code = 'ENOSPC'; throw error;
    }
    return append.call(fs, path, data, ...options);
  };
}
require('node:module').syncBuiltinESMExports();
