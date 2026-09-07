type Storage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

/** Serialize every SDK session writer with account-owned deletion cleanup. */
export function createLockedAuthStorage(base: Storage) {
  let pending: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation, operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    storage: {
      getItem: (key: string) => runExclusive(() => base.getItem(key)),
      setItem: (key: string, value: string) => runExclusive(() => base.setItem(key, value)),
      removeItem: (key: string) => runExclusive(() => base.removeItem(key)),
    },
    runExclusive,
  };
}
