/**
 * Q6 取证：按行切分的增量解码器。
 *
 * MCP stdio 是**换行分隔 JSON**，不是 Content-Length 分帧，所以代理必须自己按行切。
 *
 * 这里单独成模块只有一个理由：**跨 chunk 的多字节字符必须能被确定性地测到**。
 * 通过真实 pipe 去控制 chunk 边界是不可靠的，而这个 bug 恰恰只在特定边界上出现。
 *
 * ## 曾经踩过的坑（不要改回去）
 *
 * 第一版在每次 `push()` 里 `new TextDecoder()`：
 *
 * ```ts
 * push(chunk) { buf += new TextDecoder().decode(chunk, { stream: true }); }  // ❌
 * ```
 *
 * 每次新建 decoder 等于**丢掉流式状态**。一个中文字符是 3 个 UTF-8 字节，若它被 pipe 切成
 * `[..., 0xE5]` 和 `[0x8E, 0x8B, ...]` 两个 chunk，第一个 decoder 见到一个不完整序列就吐出
 * `U+FFFD`（`�`），第二个再吐一个。结果是中文 query 与搜索结果**双向都可能被破坏**：
 * 请求不再是逐字节透传，返回的卡片正文出现乱码，进而造成**虚假的 E1 / 装置失败**——
 * 那种失败会被记成"agent 没看到线索"，而真正的原因是代理自己把字节弄坏了。
 *
 * 正确写法是**单个长生命周期 decoder** + `{ stream: true }`，并在 `flush()` 里
 * 调一次无参 `decode()` 把残留字节吐出来（不吐的话，末尾未闭合的序列会被静默丢弃）。
 */
export interface LineSplitter {
  /** 喂入一个字节块，对其中每一条完整行调用回调。 */
  push(chunk: Uint8Array): void;
  /** 流结束时调用：吐出解码器残留字节，并把最后一段不带换行的内容作为一行发出。 */
  flush(): void;
}

export function makeLineSplitter(onLine: (line: string) => void): LineSplitter {
  // 单个 decoder，贯穿整个流的生命周期。这就是修复本身。
  const decoder = new TextDecoder();
  let buf = '';

  const drain = () => {
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim().length > 0) onLine(line);
    }
  };

  return {
    push(chunk: Uint8Array) {
      buf += decoder.decode(chunk, { stream: true });
      drain();
    },
    flush() {
      // 无参 decode 结束流并吐出残留；不调的话末尾未闭合序列会被静默丢弃。
      buf += decoder.decode();
      drain();
      if (buf.trim().length > 0) onLine(buf);
      buf = '';
    },
  };
}
