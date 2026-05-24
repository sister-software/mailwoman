---
sidebar_position: 19
title: DeepSeek — max_tokens covers reasoning, not just output
tags:
  - concepts
  - corpus
  - training
---

# DeepSeek — max_tokens covers reasoning, not just output

A short article on one DeepSeek API quirk that has burned every mailwoman thread that called it with reasoning enabled. Worth knowing before you write the next one.

## The trap

DeepSeek's chat-completions API takes a `max_tokens` parameter. The natural reading is "stop after this many output tokens." The actual semantic is "stop after this many **reasoning + output** tokens." With `reasoning_effort=low`, the model's internal reasoning happily consumes 75% of the budget before any output is emitted.

Thread B2's first run was configured with `max_tokens=20000` and `reasoning_effort=low`. The model's reasoning ate ~15K tokens per response, leaving ~5K for output. Most transliteration responses needed more than 5K (multi-script transliteration of an address row plus its annotation is large). Every truncated response was returned with `finish_reason=length` and a partial body.

If the worker treats `finish_reason=length` as a successful completion (most starter implementations do), the partial body is fed into downstream parsing and the row is silently malformed. Throughput appears fine — the worker is consuming responses at the API's nominal rate — but the corpus that lands on disk is partial.

## How to detect it

The single best signal is the rejection-pipeline log. If the substring validator (see [Synthetic corpus — alignment validation](./synthetic-corpus-validation.md)) starts rejecting rows in batches, with reasons like `not-in-raw:postcode` clustered at end-of-row positions, the LLM responses are being truncated. The validator is doing the right thing — it would silently corrupt the corpus without it.

The second signal is `finish_reason` itself. Logging the distribution per batch shows the truncation rate directly. A healthy run is `finish_reason=stop` >99% of the time; truncation rates above 1% are a configuration bug.

## The fix

Three changes to the worker:

1. **Bump `max_tokens`** generously enough that reasoning + output fits. For mailwoman's address-transliteration prompts, B2 settled on `max_tokens=60000`. Pure-output tasks can stay lower (~5K) but anything with reasoning should err well above what feels comfortable.
2. **Retry on `finish_reason=length`** rather than accepting the partial response. The B2 patch added a one-shot retry with `max_tokens` bumped to 90K (1.5× the configured value). If the retry also truncates, the row is dropped with a structured rejection reason — the validator never sees malformed input.
3. **Log truncation rate per batch**. Surfaces the problem before it can poison the corpus. The B2 worker writes a per-batch summary line; the `truncated=` counter is the headline.

## Why the API does it this way

Reasoning models are still pricing in compute differently than vanilla generation. Reasoning tokens cost the same as output tokens but are not returned to the caller. Charging them against the same budget is the simple model — one number, predictable cost ceiling. The trap is that the parameter name does not advertise the semantic.

DeepSeek's documentation does state this, in a sentence buried under the reasoning-effort overview. If you discover the trap by reading the docs, well done. If you discover it by watching your corpus get silently truncated, you are in good company — Thread B2's first run was the first time we hit it inside the playpen workflow, and the patch took longer than the original generation would have if we had set the budget right at the start.

## Carry forward

When writing the next DeepSeek-driven worker:

1. Default `max_tokens` to 3× the natural output ceiling, not 1×.
2. Wire `finish_reason=length` as a retry, never a success.
3. Surface truncation rate in the per-batch summary line.
4. Run a 50-row smoke pass first and verify `finish_reason=stop` rate before committing to the full run.

## See also

- [Synthetic corpus — alignment validation is load-bearing](./synthetic-corpus-validation.md) — why the validator caught this even when the worker silently accepted truncated responses
- [`CORPUS_V0_4_0_GENERATION.md`](../plan/reference/CORPUS_V0_4_0_GENERATION.md) — the operational record, including B2's actual prompt-engineering decisions and rate parameters
