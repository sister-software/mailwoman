---
sidebar_position: 1
title: Start here
---

# Understanding Mailwoman

This track is for readers who:

- worked with **Pelias**, **libpostal**, or earlier versions of **Mailwoman** (v1) and want to know what changed,
- want a clear picture of what Mailwoman does today, without diving into the source code,
- are about to consume the documentation in [`concepts/`](../concepts/README.md) and want a map first.

If you already know Pelias and you only want the short version: read [`from-pelias-to-mailwoman.md`](./from-pelias-to-mailwoman.md) and then [`how-it-works-now.md`](./how-it-works-now.md).

If you are new to geocoding entirely: start with [`what-is-an-address.md`](../concepts/what-is-an-address.md), then come back here.

## Reading order

1. **[From Pelias to Mailwoman](./from-pelias-to-mailwoman.md)** — the short historical bridge.
2. **[How it used to work](./how-it-used-to-work.md)** — Mailwoman v1 in detail.
3. **[How it works now](./how-it-works-now.md)** — the current rule + neural hybrid.
4. **[How it will work](./how-it-will-work.md)** — what is coming in v0.4.0 and beyond.
5. **[Glossary](./glossary.md)** — every technical term used in the deep dives.

Each article is short on purpose (about 5–10 minutes to read). Deeper material lives in the [`concepts/`](../concepts/README.md) track, which you can read in any order once you finish here.

## A note on language

The team behind Mailwoman speaks many languages, and English is a second language for many readers. Our goal in these docs is **plain English with technical terms defined on first use**. If a sentence is hard to follow, that is a documentation bug — please open an issue.

## A note on what changed

Mailwoman moved from a **purely rule-based** classifier (close to Pelias's design) to a **hybrid of rule + neural** classifiers in 2026. The rule classifiers did not go away; the neural classifier is **additive**. We migrate one address component at a time, only when the metrics justify it. This pattern is called **Ship of Theseus** in the implementation plan ([`plan/README.md`](../plan/README.md)).

The neural part introduces concepts that are not familiar to people from the Pelias world: tokenizers, transformer encoders, BIO labels, CRF decoders, ONNX runtimes. The [`concepts/`](../concepts/README.md) track explains each one in isolation.

## Where this lives in the repo

```
docs/
├── articles/
│   ├── understanding/     ← you are here
│   ├── concepts/          ← per-concept deep dives
│   ├── plan/              ← operator + agent technical plan
│   └── evals/             ← per-version evaluation reports
└── src/pages/demo/        ← the live browser-side demo
```
