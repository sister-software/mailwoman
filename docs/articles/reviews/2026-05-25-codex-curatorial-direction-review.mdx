# Codex review - project direction, technical decisions, and documentation curation

Date: 2026-05-25

Scope: public docs, concept articles, plan/reference docs, eval reports, retrospectives, blog posts, and selected code/package files used to verify status claims. The two 2026-05-25 Deepseek review files were read only after the independent review pass and used as a sanity check.

## Executive summary

Mailwoman's direction is coherent and worth continuing: a TypeScript-native address parser/resolver that runs in Node and the browser, combines deterministic rules with a small neural classifier, and uses a staged pipeline to keep learned, lookup, and constraint-composition knowledge in the right layers. The best project idea is not "neural geocoding" in the abstract; it is the Knowledge Ladder: learn context-sensitive address structure, look up world facts in a gazetteer, then reconcile candidates rather than trusting local argmaxes.

The main risk is not that the architecture is wrong. The risk is that the docs and roadmap let too many states coexist: historical plan, shipped code, in-progress training, feature-flag scaffolding, and public product story are interleaved without a single canonical status layer. A newcomer can understand the philosophy, but cannot reliably answer "what can I install today, what works, and what is still experimental?"

The documentation needs curatorial direction more than prose rewrites. Preserve the strong essays. Add a status page, getting-started path, API reference, audience labels, and a current-state reconciliation sweep. Move operator material out of the default reader path. Treat blog posts as narrative explanations, not canonical status.

## Audience fit

The stated target reader is a capable software engineer with basic geocoding intuition, little or no language-model knowledge, and curiosity about the project. The docs partially serve them well:

- The "Understanding Mailwoman" track is strong at explaining why addresses are hard before selling the solution.
- The "simple geocoders" appendix is unusually credible because it steel-mans alternatives.
- The "Two voices arguing inside a model" blog post is the best ML primer in the repo: concrete, honest, and non-condescending.
- The WOF content gives a rare practical bridge between geocoding theory and real open-data engineering.

But the reader is repeatedly dropped into operator state:

- `plan/reference/ARCHITECTURE.md` still contains old layout and label-count claims alongside useful design rationale.
- `STAGES.md`, `how-it-works-now.md`, `the-staged-pipeline.md`, and code comments disagree on locale gate default wiring and candidate-list state.
- Blog posts contain the clearest explanations, but they assume a serial project-log reader.
- There is no consolidated "install, parse, resolve, interpret output" path.

Curatorial target: make the default path answer three questions in order:

1. What problem does Mailwoman solve?
2. Can I use it today, and with what caveats?
3. How does the staged neural/rule/resolver architecture work?

## Project direction

The right product identity is:

> TypeScript-native open geocoding front end: parse address strings into structured components, surface ambiguity, and resolve against open gazetteers locally or in-browser.

That is narrower and stronger than "natural language classification engine for geocoding." It says who should care and why:

- Node/browser developers who cannot send every query to Google.
- Geocoding stacks that need local parsers, auditable failures, or custom retraining.
- Researchers/practitioners who want a small, inspectable neural address parser rather than a black-box LLM.

Avoid positioning Mailwoman as a rooftop geocoder or Google competitor. The resolver currently resolves places and administrative/postcode-level candidates, not address points. That limitation should be explicit and repeated wherever "geocoder" appears.

## Technical decisions - keep

### TypeScript runtime, Python training

This split is correct. Runtime consumers get npm packages, browser viability, and ONNX inference; training keeps PyTorch and the Python ML ecosystem where they belong. Keep training internals out of the user-facing path.

### Small encoder-only classifier

The small transformer is a sound fit for token/span labelling. A generative LLM would be slower, harder to audit, and worse aligned with "return spans from the input." The docs should keep explaining that the model labels existing tokens; it does not generate addresses or memorize the world.

### Rules plus neural, not rules versus neural

The Ship-of-Theseus policy registry is the right migration model. Postcodes, state abbreviations, and bounded format recognizers should remain deterministic. Neural should earn authority per component and per locale.

### Parse/resolve separation

This is foundational. The parser should not memorize WOF; the resolver should not infer grammar. WOF parent chains are a constraint source for reconciliation, not model training targets.

### QueryShape, kind classifier, phrase grouper

Cheap structural priors before neural classification are a good engineering compromise. They preserve browser budget and make failure modes inspectable. The phrase grouper addresses a real BIO weakness: boundary discovery and semantic type are entangled if left entirely to per-token labels.

### CRF as inference-time structure

Keeping a frozen BIO mask and Viterbi at inference while dropping CRF-NLL from training is a strong simplification if CE-only training continues to hold. The structural guarantee comes from the mask; learned CRF transitions have not yet justified their training risk.

### Browser-first constraint

The 60 MB-ish demo budget forces useful discipline: small weights, slim resolver distribution, and no hidden server dependency. Keep it as a public non-negotiable.

## Technical decisions - tighten

### Validate the architecture end to end before expanding it

The central architectural claim is "candidate generation plus joint coherence beats per-stage argmax." The code has the pieces, but docs admit the default path still falls back unless `forceJointReconcile` and `parseWithLogits` are available. Prove this path with existing weights before new model work:

- phrase proposals from `@mailwoman/phrase-grouper`
- real per-token logits from `NeuralAddressClassifier.parseWithLogits`
- span-level top-k via `aggregateSpanLogits`
- `reconcileSpans`
- resolver candidate/parent-chain scoring where available

Gate should compare argmax vs joint reconcile on golden plus kryptonite cases. This is CPU/TypeScript work, not a GPU-training blocker.

### Stop bundling training-side changes

The docs themselves learned "one change at a time" from v0.4.0, then v0.5.0 still bundled tokenizer, corpus, phrase priors, hidden-size exploration, and C-train recipe changes. Keep code scaffolds parallel, but training experiments need one primary variable and a written bisect plan before launch.

### Treat synthetic data as curriculum

LLM-generated transliteration/kryptonite rows are useful, but substring validation only proves alignment, not semantic correctness or distributional safety. Synthetic rows need:

- source-specific caps or curriculum weights
- per-source gradient/quality dashboards
- semantic spot checks
- separate eval slices
- promotion criteria before they join the main train distribution

### Add product-level evals

Per-component F1 is not enough for this project. Each ship should report:

- rule-only vs neural-only vs hybrid vs joint-decode
- full-parse exact match
- empty-parse rate
- overconfident-wrong rate
- calibration by parse, not just token
- top-1 resolver accuracy and top-5 recall where gold exists
- per-failure-class results from the "addresses that break geocoders" taxonomy

### Clarify resolver precision

Docs say "address parser + geocoder" and show coordinates. They should also say the current open WOF resolver is not rooftop/address-point geocoding. It resolves administrative places/postcodes and returns candidates. Address-point lookup is out of scope unless a future resolver backend adds that data.

## Documentation critique

### 1. Missing canonical status page

This is the highest-leverage docs fix. Create `/docs/status` and make it the first docs link after the demo.

It should include:

- package list and versions
- what runs in Node
- what runs in browser
- current weights, corpus, tokenizer, and known F1 limits
- default vs feature-flagged vs scaffold-only stages
- current training state
- known regressions and blockers
- "not supported today" list

Status should be maintained here and referenced elsewhere. Blog posts and phase docs should not be treated as current truth.

### 2. Missing getting-started and API pages

The homepage has snippets, but docs need durable pages:

- `/docs/getting-started`: install, parse first address, use CLI, use browser demo, choose packages, known caveats.
- `/docs/api`: `NeuralAddressClassifier`, `createRuntimePipeline`, CLI flags, output shapes, `AddressTree`, `alternatives`, confidence semantics.

The target reader can handle TypeScript; give them the concrete entry points.

### 3. Audience boundaries are too porous

Add "Who this is for" blocks to top-level and operator-heavy docs:

- Understanding: curious engineer/domain learner.
- Concepts: implementer/technical evaluator.
- Plan/reference: contributor/operator; historical unless status page says current.
- Evals: model-quality reviewer.
- Retrospectives/blog: narrative history.

`TRAINING_ENV.md`, `VERDICT_SMOKES.md`, `OPERATIONS.md`, and most phase files should be visually marked as operator docs.

### 4. Terminology needs reconciliation

The repo uses:

- Stage: runtime pipeline stage
- Tier: label-vocabulary expansion
- Phase: implementation-plan milestone
- Thread: parallel ship workstream

This is manageable only if defined early and consistently. Add these terms to glossary and `plan/README.md`. Rename or at least frontmatter-label old `stage2-*` eval artifacts as historical Tier 2 naming.

### 5. Status drift is now a docs bug class

Examples found during review:

- `CRF decoder` says JS inference-time Viterbi is "not yet"; several newer docs and code say it shipped and is default.
- `how-it-works-now` says locale gate workspace exists but factory default falls back to caller trust; `STAGES.md` says it is wired as default; `mailwoman/runtime-pipeline.ts` still does not wire `@mailwoman/locale-gate` by default.
- `STAGES.md` status says candidate-list API is scaffold-only/designed, then later says `AddressNode.alternatives` shipped.
- `ARCHITECTURE.md` still references a `packages/` layout and 47-label vocabulary, while current docs/code discuss root workspaces and 21 BIO labels.
- `v0-5-0-shipped.md` says B2 is still cooking; later docs/blogs say B2 landed.
- Some code comments in `mailwoman/runtime-pipeline.ts` describe kind classifier as not production-ready while it is wired by default.

Fix with one sweep after `/docs/status` exists. Do not try to make every historical doc timeless; date-stamp and redirect to status.

### 6. Homepage sends users to wrong first document

The primary CTA is "Read the plan." For the target reader, this is too internal. Replace or reorder CTAs:

1. Try the demo
2. Get started
3. Read the architecture
4. Read the plan

The plan is valuable, but it should not be the first public path.

### 7. Blog posts need standalone preambles

The blog is strong but serial. Add short "new here" preambles to:

- `two-voices-arguing`
- `taming-whosonfirst`
- `v0-4-0-ablation-campaign`
- `v0-5-0-c-train-bisect`

Each should define Mailwoman in one sentence and state whether the post is conceptual, historical, or current status.

### 8. Move best blog explanations into docs

Promote or extract:

- "Two voices" -> beginner companion to `dual-loss-curvature-conflict.md`
- "Taming WOF" -> public WOF gotchas/reference article
- v0.4.0 failure bucketing -> eval-methodology article

Blogs can keep narrative; docs should carry stable concepts.

### 9. Quantitative public claims need citations or softer framing

Tables on Google pricing, geocoder accuracy by housing type, coverage claims, and manual correction costs are rhetorically useful but look precise. Add citations, date stamps, or soften to "illustrative." For public credibility, unsupported exact numbers are more damaging than approximate qualitative claims.

## Recommended docs structure

```text
Docs
  Start here
    Status
    Getting started
    API
    Demo guide
  Understanding Mailwoman
    Problem/domain articles
    Why neural
    Staged architecture overview
    Alternatives
  Concepts
    Tokenization
    BIO labels
    Neural classification
    CRF/Viterbi
    Reconcile
    Resolver/WOF
    Training pipeline
    Corpus construction
  Quality
    Eval dashboard
    Eval methodology
    Model cards / releases
  Operator notes
    Plan
    Phase files
    Training environment
    Verdict smokes
    Release process
  Retrospectives
    v0.4.0
    v0.5.0
    Training divergence investigation
```

This preserves depth while giving each audience a door.

## Priority next steps

### Immediate

1. Create `/docs/status`.
2. Create `/docs/getting-started`.
3. Create `/docs/api`.
4. Add glossary entries for Stage/Tier/Phase/Thread and label historical Stage-vs-Tier artifacts.
5. Fix the most visible state contradictions: CRF runtime status, locale gate default, candidate-list status, v0.5.0 B2 status, `ARCHITECTURE.md` layout/label count.

### Next engineering cycle

6. Wire and evaluate `forceJointReconcile` with real logits and phrase proposals using current weights.
7. Produce product-level eval matrix: rule-only, neural-only, hybrid, joint-decode.
8. If CE-only full train succeeds, ship weights with explicit caveats and model card; if not, continue corpus/tokenizer bisect with synthetic-source weights capped.

### Next docs cycle

9. Add standalone preambles to key blog posts.
10. Extract WOF gotchas and dual-loss beginner explanation into concept docs.
11. Mark operator docs with audience headers.
12. Audit public quantitative claims for citations or softer language.

## Deepseek sanity check

After the independent pass, the two provided Deepseek notes largely confirmed the same conclusions: strong architecture, serious status drift, missing status/getting-started/API pages, terminology confusion, and end-to-end reconcile validation as a key next step. Two points from those notes are worth carrying forward explicitly:

- The "gap" sentence from `CONTEXT.md` should be louder: there is no widely adopted neural address parser shipped as a library.
- The current usable-product story must be honest: yes, you can run pieces today, but the neural model's standalone component F1 is limited and the strongest architecture path still needs end-to-end default-path validation.

## Bottom line

Continue. Narrow.

The decomposition is right: deterministic rules for bounded facts, small neural classifier for contextual ambiguity, structural priors before classification, joint reconcile after candidate generation, and WOF/open gazetteers for world knowledge. Protect that shape.

The next risk-reduction work is not another new stage. It is status clarity, user entry points, end-to-end joint-reconcile validation, and one-variable training discipline.
