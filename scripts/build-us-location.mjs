import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../mobile/lib/usLocation.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
writeFileSync(new URL('../us-location.js', import.meta.url), '// Generated from mobile/lib/usLocation.ts by scripts/build-us-location.mjs.\n(function () {\nconst exports = {};\n' + code + '\nwindow.BaristaMatchLocation = Object.freeze(exports);\n})();\n');
