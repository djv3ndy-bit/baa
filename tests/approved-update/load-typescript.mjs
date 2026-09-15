import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const require = createRequire(new URL('../../mobile/package.json', import.meta.url));
const ts = require('typescript');
export function loadTypescript(path, mocks = {}) {
  const file = fileURLToPath(new URL(`../../${path}`, import.meta.url));
  const module = { exports: {} };
  const output = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports, Intl, setTimeout, clearTimeout, Promise,
    require(name) { if (Object.hasOwn(mocks, name)) return mocks[name]; throw new Error(`Unexpected dependency: ${name}`); },
  }, { filename: file });
  return module.exports;
}
export const plain = value => JSON.parse(JSON.stringify(value));
