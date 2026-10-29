import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('updated dependencies preserve MCP schema limits and reject invalid approval input offline', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
    import { createOfficeMcpServer } from './server/mcp.ts';
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error('Network disabled in test'); };
    const server = createOfficeMcpServer();
    const client = new Client({ name: 'schema-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const schema = tools.find(tool => tool.name === 'request_owner_action').inputSchema;
      assert.deepEqual([...schema.required].sort(), ['action', 'agent', 'summary']);
      assert.equal(schema.properties.action.minLength, 1);
      assert.equal(schema.properties.action.maxLength, 500);
      assert.equal(schema.properties.agent.maxLength, 80);
      assert.equal(schema.properties.summary.maxLength, 1500);
      assert.deepEqual(schema.properties.priority.enum, ['Critical', 'High', 'Medium', 'Low']);
      for (const bad of [{ action: '' }, { summary: 'x'.repeat(1501) }, { priority: 'Invalid' }]) {
        const response = await client.callTool({ name: 'request_owner_action', arguments: {
          action: 'review', agent: 'Engineering', summary: 'offline test', ...bad
        }});
        assert.equal(response.isError, true);
      }
      assert.equal(networkCalls, 0);
    } finally {
      await client.close();
      await server.close();
    }
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
