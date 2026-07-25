import { describe, expect, test } from 'bun:test';
import { ACPPool } from '../../src/acp/pool';

class FakeRuntime {
  alive = true;
  isContaminated = false;
  constructor(
    private startError?: Error,
    private promptError?: Error,
    private text = 'ok',
  ) {}
  async start() { if (this.startError) { this.alive = false; throw this.startError; } return {} as any; }
  async createSession() { return 's'; }
  async prompt() { if (this.promptError) { this.alive = false; throw this.promptError; } return { text: this.text }; }
  async close() { this.alive = false; }
}

describe('ACPPool recycle failure', () => {
  test('removes a dead slot so the next task can create a fresh runtime', async () => {
    const runtimes = [
      new FakeRuntime(undefined, new Error('prompt failed')),
      new FakeRuntime(new Error('replacement start failed')),
      new FakeRuntime(undefined, undefined, 'recovered'),
    ];
    const pool = new ACPPool({
      concurrency: 1,
      runtimeFactory: () => runtimes.shift() as any,
    });

    await expect(pool.run('first')).rejects.toThrow('replacement start failed');
    expect(pool.stats.total).toBe(0);

    const result = await Promise.race([
      pool.run('second'),
      Bun.sleep(250).then(() => { throw new Error('pool hung after recycle failure'); }),
    ]);
    expect(result.text).toBe('recovered');
    await pool.close();
  });
});
