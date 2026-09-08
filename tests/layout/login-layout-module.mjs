import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(resolve(fileURLToPath(new URL('../../', import.meta.url)), 'mobile/lib/loginLayout.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const compiled = { exports: {} };
vm.runInNewContext(output, { module: compiled, exports: compiled.exports, Math }, { filename: 'mobile/lib/loginLayout.ts' });

export const { LOGIN_LAYOUT_METRICS, resolveLoginLayout } = compiled.exports;
