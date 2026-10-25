import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approves } from './agentSession';

const script = (...tools: string[]) => ({ toolUses: [{ details: { type: 'script', calls: tools.map((toolName) => ({ toolName })) } }] });

test('a permission is granted only for our tools', () => {
  assert.equal(approves(script('desk___invoices', 'desk___hold_off')), true);
  assert.equal(approves({ toolUses: [{ details: { type: 'mcp_tool', serverName: 'desk' } }] }), true);
});

test('anything else is refused: other tools, a script with no tool calls, shell, nothing', () => {
  assert.equal(approves(script('desk___invoices', 'Execute')), false);
  assert.equal(approves(script()), false);
  assert.equal(approves({ toolUses: [{ details: { type: 'mcp_tool', serverName: 'github' } }] }), false);
  assert.equal(approves({ toolUses: [{ details: { type: 'exec', command: 'rm -rf /' } }] }), false);
  assert.equal(approves({ toolUses: [] }), false);
  assert.equal(approves(undefined), false);
});
