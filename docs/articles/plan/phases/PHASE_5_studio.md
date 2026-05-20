# Phase 5 — Studio (Human-in-the-Loop Correction)

**Goal:** a web UI where humans can paste an address, see the parse, correct spans, and submit corrections. Corrections feed back into corpus retraining. This is the commercial differentiator — enterprises will pay for the ability to correct their own address data.

**Status:** deferred until Phase 3 has shipped and gathered usage. Do not begin Phase 5 without explicit confirmation.

**This document is a sketch.** Detailed plan will be written when Phase 5 begins.

## Why this matters

- Address parsing has a long tail of locale-specific edge cases that no amount of pretraining catches
- Customers with their own address datasets (real estate, logistics, government compliance) need to fix model output for their data
- The studio is what turns a free library into a commercial product line

## Sketch of components

### Frontend

- React or Svelte (project creator's call)
- Paste address → see live parse with span boundaries
- Drag span edges to adjust boundaries
- Right-click span to relabel component
- Submit correction with optional notes

### Backend

- Postgres table: `corrections { id, raw, original_parse, corrected_parse, user_id, project_id, created_at, notes }`
- API: `POST /corrections`, `GET /corrections?project_id=...`
- Auth: minimal — project tokens, no full user system v1

### Retraining loop

- Nightly job: dump new corrections to `/data/corpus/sources/corrections/`
- Tag with high sample weight
- Trigger retraining (manual confirmation, not automatic — corrections can be adversarial)

## What Phase 3 should leave in good shape

- `ClassificationProposal` carries enough info to round-trip through human correction
- The output format includes character offsets (it does) so span editing is mechanical
- Telemetry hooks exist to count "user accepted the parse as-is" vs "user corrected" — informs which components most need correction

## Open questions for when Phase 5 begins

- Is this open source or commercial-only?
- How does the correction format become training data? (BIO labels need to be re-derived from corrected components)
- Quality gating: are all corrections trusted equally, or does each project's corrections only affect that project's model?
- Does the studio host its own model fine-tuned on the project's corrections?
