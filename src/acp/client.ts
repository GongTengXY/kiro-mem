/**
 * Low-level JSON-RPC 2.0 stdio client for `kiro-cli acp`.
 * Handles process lifecycle, request/response routing, and notification dispatch.
 */

import { spawn, type Subprocess } from 'bun';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
} from './types';

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

export interface ACPClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  onNotification?: NotificationHandler;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null) => void;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ACPClient {
  private proc: Subprocess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private onNotification: NotificationHandler;
  private onStderr: (line: string) => void;
  private onExit: (code: number | null) => void;
  private buffer = '';
  private closed = false;
  private opts: ACPClientOptions;

  constructor(opts: ACPClientOptions) {
    this.opts = opts;
    this.onNotification = opts.onNotification ?? (() => {});
    this.onStderr = opts.onStderr ?? (() => {});
    this.onExit = opts.onExit ?? (() => {});
  }

  /** Spawn the ACP process and start reading. */
  start(): void {
    if (this.proc) return;
    this.closed = false;

    this.proc = spawn({
      cmd: [this.opts.command, ...(this.opts.args ?? [])],
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    this.readStdout();
    this.readStderr();
    this.proc.exited.then((code) => {
      this.closed = true;
      this.rejectAll(new Error(`ACP process exited with code ${code}`));
      this.onExit(code);
    });
  }

  get alive(): boolean {
    return !this.closed && this.proc != null;
  }

  /**
   * PID of the spawned `kiro-cli acp` process, or null before start / after exit.
   *
   * Exposed only so the Worker can attribute resident memory to it. Measured on
   * this machine, one runtime is 9.8MB in this process plus a 28.1MB child of
   * its own — reporting the Worker's own RSS alone therefore misses the larger
   * half of the pool's cost, which is exactly the number the internal-test data
   * collection has to answer.
   */
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** Send a JSON-RPC request and wait for the response. */
  async request(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    if (!this.proc || this.closed) {
      throw new Error('ACP client not started or already closed');
    }

    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.write(msg);
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.proc || this.closed) return;
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.write(msg);
  }

  /** Kill the process and clean up. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error('ACP client closed'));
    if (this.proc) {
      try {
        (this.proc.stdin as any).end?.();
        this.proc.kill();
      } catch {}
      this.proc = null;
    }
  }

  // --- Internal ---

  private write(msg: JsonRpcMessage): void {
    if (!this.proc || this.closed) return;
    const json = JSON.stringify(msg);
    try {
      const stdin = this.proc.stdin as any;
      stdin.write(json + '\n');
      stdin.flush?.();
    } catch {
      // Process may have died between alive check and write
    }
  }

  private async readStdout(): Promise<void> {
    const stdout = this.proc?.stdout as ReadableStream<Uint8Array> | undefined;
    if (!stdout) return;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch {
      // Stream closed
    }
  }

  private async readStderr(): Promise<void> {
    const stderr = this.proc?.stderr as ReadableStream<Uint8Array> | undefined;
    if (!stderr) return;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    let stderrBuf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrBuf += decoder.decode(value, { stream: true });
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this.onStderr(line);
        }
      }
    } catch {
      // Stream closed
    }
  }

  private processBuffer(): void {
    // ACP uses newline-delimited JSON
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        this.dispatch(msg);
      } catch {
        // Ignore malformed lines
      }
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if ('id' in msg && msg.id != null && !('method' in msg && !('result' in msg || 'error' in msg))) {
      // Response
      const resp = msg as JsonRpcResponse;
      const pending = this.pending.get(resp.id);
      if (pending) {
        this.pending.delete(resp.id);
        clearTimeout(pending.timer);
        if (resp.error) {
          pending.reject(new Error(`ACP error [${resp.error.code}]: ${resp.error.message}`));
        } else {
          pending.resolve(resp.result);
        }
      }
    } else if ('method' in msg && !('id' in msg)) {
      // Notification
      const notif = msg as JsonRpcNotification;
      this.onNotification(notif.method, notif.params ?? {});
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
