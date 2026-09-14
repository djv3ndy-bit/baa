import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadModule({ platform = 'ios', nativeModule = null, loadError } = {}) {
  let nativeLoads = 0;
  const exports = {};
  vm.runInNewContext(javascript, {
    exports,
    require(name) {
      if (name === 'react-native') return { Platform: { OS: platform } };
      if (name === 'expo') {
        return {
          requireOptionalNativeModule(moduleName) {
            assert.equal(moduleName, 'BaristaMatchStorefront');
            nativeLoads += 1;
            if (loadError) throw loadError;
            return nativeModule;
          },
        };
      }
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { ...exports, nativeLoads: () => nativeLoads };
}

for (const platform of ['android', 'web']) {
  test(`${platform} returns null without loading an Apple module`, async () => {
    const module = loadModule({ platform });
    assert.equal(await module.getStorefrontCountryCode(), null);
    assert.equal(module.nativeLoads(), 0);
  });
}

test('older binaries without the native module return null', async () => {
  assert.equal(await loadModule().getStorefrontCountryCode(), null);
});

test('native module loading failures return null', async () => {
  const module = loadModule({ loadError: new Error('Unavailable bridge') });
  assert.equal(await module.getStorefrontCountryCode(), null);
});

test('StoreKit query failures return null', async () => {
  const module = loadModule({
    nativeModule: { getStorefrontCountryCode: async () => { throw new Error('Unavailable storefront'); } },
  });
  assert.equal(await module.getStorefrontCountryCode(), null);
});

test('a native module missing the query method returns null', async () => {
  assert.equal(await loadModule({ nativeModule: {} }).getStorefrontCountryCode(), null);
});

for (const countryCode of [null, undefined, '', 'US', 'usa', 840, {}, true]) {
  test(`invalid or unavailable storefront ${JSON.stringify(countryCode)} returns null`, async () => {
    const module = loadModule({
      nativeModule: { getStorefrontCountryCode: async () => countryCode },
    });
    assert.equal(await module.getStorefrontCountryCode(), null);
  });
}

test('returns Apple alpha-3 codes and queries afresh after a storefront change', async () => {
  let countryCode = 'USA';
  let queries = 0;
  const module = loadModule({
    nativeModule: {
      getStorefrontCountryCode: async () => { queries += 1; return countryCode; },
    },
  });
  assert.equal(await module.getStorefrontCountryCode(), 'USA');
  countryCode = 'FRA';
  assert.equal(await module.getStorefrontCountryCode(), 'FRA');
  assert.equal(queries, 2);
});
