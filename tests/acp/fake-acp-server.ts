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
  // By default the server exits when its stdin closes, which is what a real ACP
  // agent does when its parent dies. `KIRO_MEM_FAKE_SURVIVE_EOF` opts out, so an
  // orphaned runtime stays observable: otherwise a leaked process self-terminates
  // the moment the Worker exits and a shutdown-leak test passes vacuously.
  if (process.env.KIRO_MEM_FAKE_SURVIVE_EOF === '1') {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
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

    // Test directive: `hang:` never answers, so the prompt stays in flight until
    // the client closes it. Used to reproduce the shutdown race where a prompt
    // rejected by `close()` used to trigger a replacement runtime.
    //
    // `KIRO_MEM_FAKE_HANG` does the same for every prompt, which is how the
    // Worker-level test gets a prompt in flight: the Worker builds its own
    // compression prompt, so the directive cannot be injected through the text.
    //
    // `KIRO_MEM_FAKE_HANG_MARKER` is how a test knows the prompt is REALLY in
    // flight. Waiting on "a pid exists" is not enough — slots are reserved before
    // `start()` resolves, so a test that closes on that signal interrupts the
    // handshake instead of the prompt and never reaches the race it targets.
    const hangAll = process.env.KIRO_MEM_FAKE_HANG === '1';
    if (hangAll || (typeof text === 'string' && text.startsWith('hang:'))) {
      const marker = process.env.KIRO_MEM_FAKE_HANG_MARKER;
      if (marker) {
        try { require('fs').writeFileSync(marker, 'hanging'); } catch {}
      }
      return;
    }

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
