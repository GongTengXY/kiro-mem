# all-MiniLM-L6-v2 (q8 quantized, ONNX)

This directory contains a quantized ONNX build of
[`sentence-transformers/all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2),
bundled with `kiro-mem` so the runtime can load it via `local_files_only` without any network access.

| File                            | Purpose                                             |
| ------------------------------- | --------------------------------------------------- |
| `config.json`                   | model config                                        |
| `tokenizer.json`                | fast tokenizer                                      |
| `tokenizer_config.json`         | tokenizer init args                                 |
| `onnx/model_quantized.onnx`     | int8 quantized weights (~22 MB), used at runtime    |

## License

The original model is released under **Apache License 2.0** by
[Sentence Transformers / UKP Lab](https://www.sbert.net/).

Redistribution as part of `kiro-mem` complies with the Apache 2.0 license.
This NOTICE preserves the upstream attribution. Please consult the upstream
model card for the canonical license text and citation requirements.

## Reproduction

The quantized ONNX export is the same one used by
`@huggingface/transformers` when loaded with `dtype: 'q8'`. To regenerate it
from the original model, see the upstream model card.
