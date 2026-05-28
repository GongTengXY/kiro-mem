#!/usr/bin/env bun
/**
 * Fake ACP server for testing. Reads JSON-RPC from stdin, responds on stdout.
 * Simulates: initialize, session/new, session/prompt (with session/update notifications
 * and a final stopReason response).
 */

const decoder = new TextDecoder();
let buffer = '';

const reader = Bun.stdin.stream().getReader();

async function main() {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      handleMessage(JSON.parse(line));
    }
  }
}

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handleMessage(msg: { id?: number; method?: string; params?: any }) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'fake-acp', version: '0.0.1' },
      },
    });
  } else if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { sessionId: 'test-session-001' },
    });
  } else if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId ?? 'test-session-001';
    const text = msg.params?.prompt?.[0]?.text ?? '';

    // Test directive: `tool:<name>` simulates a contamination event. The fake
    // agent emits a tool_call update and still completes the prompt turn.
    const toolMatch = typeof text === 'string' ? text.match(/^tool:(\w+)/) : null;
    if (toolMatch) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'tool_call', toolCall: { name: toolMatch[1] } },
        },
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }

    // Send agent message chunks, then complete the prompt request.
    const response = text.includes('echo:') ? text.replace('echo:', '').trim() : '{"ok":true}';
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: response },
        },
      },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  } else if (msg.id != null) {
    // Unknown method — return error
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
  }
}

main().catch(() => process.exit(0));
