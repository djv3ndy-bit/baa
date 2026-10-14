import { createOfficeProviders } from './office-data.mjs';
import { chatOAuthConfiguration } from './chat-oauth.mjs';

/** A new provider closure for each verified MCP request. Credentials never
 * enter tool arguments/results. The database rechecks the grant on every read.
 */
export function createChatOfficeProviders(owner, options = {}) {
  const env = options.env || process.env;
  const config = chatOAuthConfiguration(env);
  if (!owner || owner.ownerId !== config.ownerId || !/^[a-f0-9]{64}$/.test(owner.accessHash) || typeof options.store?.snapshot !== 'function') {
    throw new Error('Office reporting is unavailable');
  }
  return createOfficeProviders(undefined, {
    env, fetchImpl: options.fetchImpl, now: options.now,
    snapshotLoader: () => options.store.snapshot(owner.accessHash, config.clientId, config.resource),
  });
}
