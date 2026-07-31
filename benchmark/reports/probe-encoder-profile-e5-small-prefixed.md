# 编码器画像：e5-small-prefixed

测的是编码器**自身**的性质，与我们的 query 集无关。跨语言那一节用的是写死在
脚本里的固定句对，不取自 `benchmark/dataset/`，因此不消耗校准集样本。

| 项 | 值 |
| --- | --- |
| 生成时间 | 2026-07-29T14:34:22.585Z |
| 命令行 | `bun run benchmark/probe-encoder-profile.ts --model=Xenova/multilingual-e5-small --label=e5-small-prefixed --query-prefix=query:  --doc-prefix=passage:  --json=/tmp/prof-e5-small-prefixed-.json` |
| 模型 | `Xenova/multilingual-e5-small` |
| 实测输出维度 | 384 |
| 前缀协议 | query=`query: ` / doc=`passage: ` |
| 运行环境 | Bun 1.2.20 / darwin arm64 |

## 体积 / 冷启动 / 内存 / 延迟

| 指标 | 值 | 说明 |
| --- | --- | --- |
| 运行所需文件之和 | **129.1 MB** | 会被打进 npm tarball 的那部分 |
| 落盘目录总体积 | 129.1 MB | 含其它精度/额外文件，不进包 |
| 冷启动到首个向量 | **462ms** | MCP 进程会话首次 search 撞的就是这段（查询超时 1200ms） |
| 短查询延迟（中位数，8 次） | 3.5ms | |
| 长文本延迟（2000 字，中位数，8 次） | 78.0ms | `embed_observation` job 的量级 |
| RSS：加载前 / 加载后 / 跑完 | 73 / **753** / 667 MB | Worker 常驻一份，**每个 Kiro 会话的 MCP 进程各一份** |

## 跨语言可用性（固定句对）

判据是**间距**（改写 − 无关），不是绝对分数：退化嵌入的典型特征恰恰是无关句对
也拿到高分，所以绝对值在模型之间不可比。间距接近 0 意味着该语言下的相似度
没有判别力。

| 语言组 | 改写对 | 无关对 | 间距 |
| --- | --- | --- | --- |
| 中文 | 0.871 | 0.833 | **0.039** |
| 英文 | 0.831 | 0.769 | **0.062** |
| 中英混排 | 0.904 | 0.840 | **0.064** |
| 标识符 | 0.842 | 0.830 | **0.012** |
