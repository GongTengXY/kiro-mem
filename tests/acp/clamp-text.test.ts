/**
 * S11：助手回复裁剪（`clampText`）的取舍验证。
 *
 * 复核文档记的担忧是"60% 头 + 40% 尾这个比例对'结论在尾部'的真实样本是否够"。
 * 先量了样本：本机真实库里 5 条助手回复是 167 / 489 / 1158 / 1648 / 2887 字符，
 * 基准数据集 30 条的中位数是 143、最大 324——**没有一条触达 3000 的阈值**。也就是
 * 说这个比例在现有真实样本上一次都没被行使，最大那条是阈值的 96%，再长一点就会
 * 开始裁。样本量不足以给出"最优比例"，所以这里做的是另一件更有用的事：把当前实现
 * 真正买到的东西钉成数字，让将来任何调整都必须先解释代价。
 *
 * 断言经过生产路径（`ACPCompressor` + fake pool），因此同时验证裁剪确实接在
 * assistant_response 这个字段上，而不只是一个孤立的纯函数。
 */
import { describe, test, expect } from 'bun:test';
import { ACPCompressor } from '../../src/acp/compressor';
import { FakeACPPool } from '../support/fake-acp-pool';

/** 生产参数：assistant_response 上限 3000，head = floor(3000*0.6)，tail = 3000-head-3。 */
const RESP_MAX = 3000;
const HEAD_BUDGET = Math.floor(RESP_MAX * 0.6); // 1800
const TAIL_BUDGET = RESP_MAX - HEAD_BUDGET - 3; // 1197

async function promptFor(assistantResponse: string): Promise<string> {
  const pool = new FakeACPPool();
  const compressor = new ACPCompressor({}, pool);
  await compressor.summarizeObservation({
    user_prompt: 'p',
    assistant_response: assistantResponse,
    artifacts: { files_touched: [], commands: [], test_signals: [], error_signals: [], facts: [] },
  });
  return pool.calls[0]!.prompt;
}

describe('S11: assistant response clamping', () => {
  test('the real-world longest sample (2887 chars) is not clamped at all', async () => {
    const body = 'x'.repeat(2887 - 20);
    const prompt = await promptFor(`START_MARKER${body}END_MARKER`);
    expect(prompt).toContain('START_MARKER');
    expect(prompt).toContain('END_MARKER');
    expect(prompt).not.toContain('\n…\n');
  });

  test('a conclusion on the final line always survives, however long the reply', async () => {
    // 结论在尾部是助手回复的常态，这是 60/40 里"40"存在的理由。
    const conclusion = '结论：三处已修复，bun test 292 pass 0 fail。';
    const prompt = await promptFor('中间过程。'.repeat(4000) + conclusion);
    expect(prompt).toContain(conclusion);
    expect(prompt).toContain('\n…\n'); // 确实裁过，不是因为没超限才通过
  });

  test('the opening survives too — the head budget is not sacrificed for the tail', async () => {
    const opening = '用户要求：把检索的误召回收口。';
    const prompt = await promptFor(opening + 'x'.repeat(20_000) + '结论：完成。');
    expect(prompt).toContain(opening);
    expect(prompt).toContain('结论：完成。');
  });

  test(`the tail budget is exactly ${TAIL_BUDGET} chars — a longer conclusion loses its beginning`, async () => {
    // 这就是当前比例真正买到的东西：尾部 1197 字符全存活，第 1198 个字符起丢失。
    // 若将来要调 60/40，必须拿这个数字对着真实样本讲清代价。
    const fits = 'A'.repeat(TAIL_BUDGET - 40) + '尾部结论刚好放得下';
    const fitsPrompt = await promptFor('中间。'.repeat(3000) + fits);
    expect(fitsPrompt).toContain(fits);

    const tooLong = 'CONCLUSION_HEAD' + 'B'.repeat(TAIL_BUDGET) + 'CONCLUSION_TAIL';
    const cutPrompt = await promptFor('中间。'.repeat(3000) + tooLong);
    expect(cutPrompt).toContain('CONCLUSION_TAIL');
    expect(cutPrompt).not.toContain('CONCLUSION_HEAD');
  });

  test('the clamped field stays within budget', async () => {
    // 用 prompt 模板里不出现的字符，否则模板自带的 'y'（memory_type 等）会被算进去。
    const prompt = await promptFor('Ω'.repeat(50_000));
    const runs = prompt.match(/Ω+/g) ?? [];
    const kept = runs.reduce((sum, run) => sum + run.length, 0);
    expect(kept).toBe(HEAD_BUDGET + TAIL_BUDGET);
    expect(kept).toBeLessThan(RESP_MAX);
  });
});
