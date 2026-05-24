const fs = require('fs');
const path = require('path');
const rootPkg = require('../package.json');

const entries = Object.entries(rootPkg.dependencies).filter(([name]) =>
  name.startsWith('database-wasm-')
);

for (const [alias] of entries) {
  const pkgJson = require(path.join('..', 'node_modules', alias, 'package.json'));
  const version = pkgJson.version;
  const src  = path.join(__dirname, '..', 'node_modules', alias, 'bundle', 'main.es.js');
  const dest = path.join(__dirname, '..', 'public', 'turso-wasm', `v${version}`, 'main.es.js');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`WASM v${version} -> ${dest}`);
}
