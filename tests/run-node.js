#!/usr/bin/env node
/* Lance la même suite que tests.html dans Node (>= 18).
 *   node tests/run-node.js                 -> fixtures intégrées
 *   node tests/run-node.js fichier1 [...]  -> + round-trip de fichiers réels
 */
'use strict';
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
for (const f of ['marshal-reader.js', 'marshal-writer.js', 'tests/fixtures.js', 'tests/test-suite.js']) {
  require(path.join(root, f));
}

(async () => {
  const res = await globalThis.MarshalTests.run((name, ok, detail) => {
    console.log(`${ok ? '\x1b[32m✔' : '\x1b[31m✘'}\x1b[0m ${name}${detail ? '  — ' + detail : ''}`);
  });
  let fileFail = 0;
  for (const file of process.argv.slice(2)) {
    try {
      const r = globalThis.MarshalTests.roundTripFile(new Uint8Array(fs.readFileSync(file)));
      console.log(`${r.ok ? '\x1b[32m✔' : '\x1b[31m✘'}\x1b[0m fichier ${file} (${r.doc.stats.nodes} nœuds)${r.ok ? '' : ' — écart à ' + r.rt.firstDiff}`);
      if (!r.ok) fileFail++;
    } catch (e) {
      fileFail++;
      console.log(`\x1b[31m✘\x1b[0m fichier ${file} — ${e.message} (offset ${e.offset})`);
    }
  }
  console.log(`\n${res.pass}/${res.total} tests OK` + (fileFail ? `, ${fileFail} fichier(s) KO` : ''));
  process.exit(res.fail || fileFail ? 1 : 0);
})();
