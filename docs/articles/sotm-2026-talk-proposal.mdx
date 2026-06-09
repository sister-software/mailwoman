# State of the Map 2026 — Talk Proposal

**Speaker:** Teffen Ellis
**Contact:** teffen@sister.software

---

## Truth or Consequences: Approximately Correct

**A Hybrid Neural Decoder for Postal Address Parsing — Shipping a Geocoder That Runs in the Browser**

## Format

30-minute presentation (talk + Q&A)

## Abstract

Postal address parsing — splitting "6220 SE Salmon St, Portland, OR 97215" into its structured components — has been dominated by two approaches: hand-tuned rule engines like libpostal, and large language models that are too heavy to run outside a datacenter. What if you could get the accuracy of a learned model in a package small enough to ship to a browser?

This talk presents _Mailwoman_, a hybrid geocoding engine that pairs a traditional rule-based classification pipeline with a lightweight neural decoder. The model is trained on a BIO-labeled corpus and runs inference through a SentencePiece tokenizer and ONNX runtime — keeping the entire weights bundle under 50 KB per locale. The result is an address parser that is both interpretable (rules light the path) and robust (the neural decoder handles ambiguity and noise), deployable anywhere from a Node.js server to a browser tab to an embedded native application.

We'll walk through the architecture: how rule classifiers and neural inference cooperate rather than compete, how a BIO structural mask plus Viterbi decoding catches errors that argmax misses, and how the full annotated source ships as open source (AGPL-3.0) for community audit and extension. We'll close with the roadmap — multilingual expansion, learned CRF transitions, and embedding the runtime into native geo toolchains.

1. **Why hybrid?** Understand the tradeoffs between pure-rule, pure-neural, and hybrid parsers for structured text extraction — and where each shines.
2. **Inference at the edge.** See how SentencePiece tokenization paired with ONNX keeps model size under 50 KB per locale, enabling browser and embedded deployment.
3. **BIO decoding done right.** Learn how a structural transition mask plus Viterbi prevents silent errors like "Saint Petersburg" being decoded as just "Petersburg."
4. **Open data, open pipeline.** Walk through the BIO-labeled corpus pipeline and how the community can contribute new locales and training data.

## Audience

Geocoding practitioners, OpenStreetMap tool builders, and anyone interested in structured text extraction at the edge. Attendees should be comfortable with the idea of address parsing but no ML background is assumed — we'll explain the neural bits from first principles.

## Prior Talk

This is a follow-up to **"Paris Texas: Technically Correct"** presented at State of the Map 2025 in Tours, which covered the pitfalls of rule-based classification engines. This talk picks up where that one left off: the neural decoder layer built on top of it over the past year.

## Project Status

Mailwoman is in active development with published and working en-US and fr-FR model weights. The fully annotated source code is scheduled for public release at the end of June 2026, ahead of the conference. The project is open source under AGPL-3.0.

## References

- Paris, Texas: Technically Correct — State of the Map 2025 Talk: https://peertube.openstreetmap.fr/w/d4ZwBJmwcLzDQ3ekWNPswA
- Mailwoman Project Website: https://mailwoman.sister.software
- Mailwoman GitHub Repository: https://github.com/sister-software/mailwoman
