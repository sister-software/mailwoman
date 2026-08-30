# Auto-decoders + coherence scoring of assembled address records

Research for the "second model that checks the first one's output" design decision.
Date: 2026-08-16. Verification method noted per claim: **[S]** = verified by web search this session, **[M]** = from model memory (pre-2026 training), **[S+M]** = existence verified by search, specific detail from memory.

---

## The plain answer first

**"Auto-decoder" is a real, established term.** It names an encoder-less generative architecture — a decoder plus a table of per-sample latent codes that are _optimized_ (by gradient descent) rather than _predicted_ (by an encoder), both at training time and, crucially, at inference time. The term was popularized by **DeepSDF (Park et al., CVPR 2019)**, which itself credits the idea to **Tan & Mavrovouniotis (1995)** [S]; the closest modern sibling is **GLO (Bojanowski et al., "Optimizing the Latent Space of Generative Networks", 2017/ICML 2018)** [S]. It is alive and productive in 2025–2026, but almost entirely inside the _neural fields_ world (3D shapes, medical imaging, video, PDE surrogates) [S]. The mechanism it embodies — "score a sample by how hard the model of normal data has to work to explain it" — **does transfer conceptually** to structured address records, and there is a worked example of the anomaly-detection use in medical imaging [S]. But the implementation does not earn its cost for your problem: an assembled address is a handful of categorical fields under a known hierarchy, and the same "explanation difficulty" signal is available far cheaper via masked field prediction (MCM-style) or, cheaper still, a count/containment lookup against the gazetteer. **Verdict: real term, right intuition, wrong rung of the ladder for this task.**

---

## Part 1 — Auto-decoder: term, lineage, distinctions, transfer

### 1.1 Origin and definition

- **DeepSDF** (Park, Florence, Straub, Newcombe, Lovegrove, CVPR 2019) introduced the name for its shape-latent scheme: one shared decoder MLP maps (latent code z_i, query point x) → SDF value; each training shape owns a free latent z_i, randomly initialized and optimized jointly with decoder weights via backprop. **At test time there is no encoder to run** — the latent for a new observation is found by gradient descent on the reconstruction objective (MAP estimation of z given observations), which is what lets DeepSDF complete shapes from _partial_ observations. [S] (multiple secondary sources; DeepSDF summaries and follow-on papers confirm both phases)
- DeepSDF's own citation for the concept is **Tan & Mavrovouniotis, 1995** ("Reducing data dimensionality through optimizing neural network inputs", AIChE) — so the idea predates deep learning's current era; DeepSDF supplied the name and the killer application. [S] (seen via DeepJoin's citation "AutoDecoder (Tan & Mavrovouniotis, 1995)"; the exact 1995 title is [M])
- **GLO** (Bojanowski, Joulin, Lopez-Paz, Szlam) is the same move for image generation: "an encoder-less autoencoder, or a discriminator-less GAN" — one learnable noise vector per training image, jointly optimized with the decoder under a simple reconstruction loss, latents constrained to the unit sphere. [S]

### 1.2 Auto-decoder vs autoencoder vs masked autoencoder

|                                                                                        | Inference of latent                                                               | Handles partial input                                               | Test-time cost                  |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------- |
| **Autoencoder**                                                                        | amortized (one encoder forward pass)                                              | poorly — encoder was trained on complete inputs                     | one forward pass                |
| **Auto-decoder**                                                                       | per-sample optimization (gradient descent at test time)                           | naturally — the reconstruction objective only covers observed parts | an optimization loop per sample |
| **Masked autoencoder / masked modeling** (MAE, He et al. 2022 [M]; BERT-style MLM [M]) | amortized encoder over the _visible_ part; decoder reconstructs the _masked_ part | yes — masking IS partial input, simulated at training time          | one forward pass                |

The required distinction for you: the auto-decoder buys robustness-to-partial-observation and a principled per-sample fit, and pays for it with **an optimization loop at every inference** — DeepSDF's known weakness (slow inference; follow-on work exists to amortize it [M]). Masked modeling buys the same robustness by _simulating_ partiality during training and keeps amortized (fast) inference. For a per-record checker in a geocoding pipeline, that cost profile decides it.

### 1.3 Reconstruction difficulty as anomaly signal — does it transfer?

- The generic autoencoder version is textbook: train on normal data, anomaly = high reconstruction error. [S] (broad literature)
- The **auto-decoder version exists and works in one domain jump already**: "Implicit field learning for unsupervised anomaly detection in medical images" (Naval Marimont & Tarroni, MICCAI 2021, arXiv:2106.05214) uses an auto-decoded implicit field over healthy anatomy; at test time the latent is optimized to explain a scan, and voxels the model _cannot_ restore are flagged as lesions. So the DeepSDF-style signal has transferred from 3D shapes to images. [S]
- **Post-2025 state**: auto-decoding conditional neural fields remain an active paradigm — 2025/2026 applications in medical imaging (Friedrich et al. 2026), video (Wolleb et al. 2025), PDE surrogates (Jo et al. 2025), plus architectural work (NeoMLP 2024/25; latent-grid and geometry-grounded conditioning). A noted 2025-era finding: raw auto-decoded latents are _hard to classify directly_ — they organize for reconstruction, not for downstream discrimination — which is a caution against assuming the latent itself is a good anomaly feature. [S]
- **I found no published auto-decoder line for tabular/structured-record anomaly detection.** [S — absence claim, bounded by my searches] That slot in the literature is occupied by masked modeling (Part 2.1) and energy-based scoring. The conceptual transfer to address records is sound (a record the normal-address model struggles to explain is suspect), but every published structured-data instantiation of that idea uses cheaper implementation.

---

## Part 2 — Coherence/plausibility scoring of assembled structured outputs

Failure case being designed against: input "Weimar, Thüringen" parsed correctly; resolver assembled locality=Weimar (Texas), region ignored — near-zero real-world joint probability, nothing flagged.

### 2.1 Masked modeling over structured records; energy-based and verifier models

- **MCM: Masked Cell Modeling for Anomaly Detection in Tabular Data (ICLR 2024)** — the direct precedent. One-class setting (train on normal rows only); the model _learns_ multiple diverse masks (with a diversity loss), reconstructs masked cells from unmasked ones, and scores anomaly as mean reconstruction error across masked versions. Rationale is exactly your problem statement: a row that violates the _inter-field correlations_ of normal data reconstructs badly. SOTA on standard tabular AD benchmarks; per-feature interpretability (which field is the incoherent one) falls out. [S]
- **TURL (VLDB 2021)** — Masked Entity Recovery over relational tables: mask an entity cell, recover it from the rest of the table + headers. Proof that BERT-style masking works when cells are _entities_ rather than free text — the closest published shape to "mask the locality node, predict it from region+country+postcode". [S] TaBERT is the QA-oriented sibling. [S]
- **Energy-based models**: SPENs (Belanger & McCallum, arXiv 1511.06350) define a learned energy over _entire candidate label assignments_ — an EBM over a field assignment is literally a coherence scorer for an assembled record. [S] **Energy-Based Reranking** for NMT (Bhattacharyya et al. 2021) is the "second model scores the first model's outputs" pattern in production form: generator proposes, EBM re-ranks. [S]
- **Verifier/critic models**: the 2024–2026 LLM literature is dense with verifiers scoring another model's structured output (hallucination verification, LLM-as-judge). Its transferable lesson for you is less the architectures than the bias findings in 2.2. [S]
- **Mapping to mailwoman**: you already own BIO masking infrastructure and a labeled corpus; the gazetteer's PARENT_OF closure can be flattened into unlimited (locality, region, country, postcode-shape) training rows. A masked-field model trained on _those_ — "given region=Thüringen and country=DE, distribution over locality" and every other masking — is MCM/TURL with your data. Note it should score the **assembled record**, i.e. operate at the unit the resolver emits, not at the token level the parser reads.

### 2.2 The echo-chamber hazard

The hazard is real and named in three adjacent literatures:

- **Confirmation bias in pseudo-labeling/self-training** (Arazo et al., arXiv 1908.02983, IJCNN 2020): a model trained on its own predictions overfits its own errors; the errors compound. Standard mitigations (mixup, minimum real-labeled quota per batch, uncertainty weighting) all amount to _diluting self-generated data with independently grounded data_. [S]
- Directly in the record/KB domain: **"Combating Confirmation Bias: A Unified Pseudo-Labeling Framework for Entity Alignment" (arXiv 2307.02075)** — the same failure documented for entity alignment specifically. [S]
- **LLM self-preference bias** (multiple 2024–2026 papers): judges systematically over-rate their own outputs, and — the sharpest finding for your design — **judges favor outputs of models trained on data the judge itself generated**. The literature's override is grounding evaluation in independently verifiable signals. [S]
- **Round-trip consistency** (Alberti et al., ACL 2019, arXiv 1906.05416): keep a generated QA pair only if an independent model answering the generated question recovers the original answer. Widely replicated as _crucial_ for synthetic-data quality. [S] Geocoding analog: format the assembled result (you own `@mailwoman/formatter` — the inverse direction already exists) and re-resolve or reverse-geocode; Weimar-TX round-trips to "Weimar, TX 78962, USA", which fails to match the parsed evidence "Thüringen". Round-trip is cheap here because both directions are already built.
- **Adversarial validation** (Kaggle-originated, now standard for drift detection [S]): train a classifier to distinguish two populations; AUC ≈ 0.5 means indistinguishable. Two uses for you: (a) resolver-assembled records vs. real gazetteer records — a high AUC is _itself_ a defect detector and its feature importances point at the incoherent field combinations; (b) a periodic audit that the checker's training distribution hasn't drifted toward resolver output.
- **Design consequence**: train the checker on the **gazetteer + labeled corpus** (independent reference data — the real-world joint distribution of (locality, region, country)), never on resolver outputs. Resolver outputs may be _scored_ by the checker; they must not be its supervision. This is the structural guarantee against blessing Weimar-TX: no amount of resolver confidence changes the fact that (Weimar, Texas, DE-context) has ~zero support in WOF.

### 2.3 The cheap-first ladder, and where published systems land

- **Rung 0 — deterministic containment (not even a count)**: your observed failure needs no probability. Weimar (TX) has a WOF ancestry; "Thüringen" was _parsed and present_; ancestry(assembled locality) ∌ parsed region is a boolean, answered by one PARENT_OF walk. The KB-QA literature's reasoner-style internal consistency checks are this rung. [M for the framing; the WOF specifics are in-house]
- **Rung 1 — count-based joint plausibility**: **SDValidate (Paulheim & Bizer, ~2014)** is the canonical published instance — score a triple by the relative frequency of its (property, object-type) combination against the KB-wide distribution, threshold the outliers. Its documented virtue: it respects _actual usage_ rather than axiomatic design, so it tolerates legitimate-but-schema-violating patterns while flagging rare nonsense. Ran at DBpedia scale. [S] Your p(region | locality) as a literal lookup over the hierarchy table is SDValidate with better data (WOF is curated; DBpedia is scraped).
- **Rung 2 — unified statistical inference**: **HoloClean (Rekatsinas, Chu, Ilyas, Ré, VLDB 2017)** — the worked mid-rung: denial constraints + co-occurrence statistics + external reference data compiled into one probabilistic model; co-occurrence stats form the _priors_, constraints the hard structure. This is the published shape of "containment check + count model + smoothing, jointly". [S]
- **Rung 3 — learned embeddings/transformers**: evidence on when this rung pays: **Mudgal et al., SIGMOD 2018** ("Deep Learning for Entity Matching: A Design Space Exploration") found deep models roughly _match_ classical (Magellan-style) matchers on clean structured records and win on **textual and dirty** attributes [S existence; specific structured-vs-dirty breakdown M]. **Ditto (VLDB 2021)** — pre-trained-LM matching — gains up to +29% F1, again concentrated on hard/dirty/textual benchmarks. [S] KG error detection has embedding-based detectors too, but the survey literature (Paulheim/Cimiano 2016; 2024 KG-quality surveys) shows statistical/distributional methods remain the deployed backbone. [S]
- **Where the ladder lands for this task**: published QA systems for entity/record linkage overwhelmingly _deploy_ rungs 0–2; the learned rung's documented wins are where fields are messy free text — which is the parser's territory, not the resolver's. The resolver's output is clean categorical fields under a closed curated hierarchy — the regime where Mudgal found deep models buy little. The learned rung (2.1's masked model) earns its place only for coherence _beyond_ the hierarchy: postcode-shape vs country, street-naming style vs locale, venue-vs-locality confusions — signals a containment walk cannot see. Build it after rungs 0–1 have eaten the cheap failures, and let its eval justify it against the rung-1 baseline (house rule: measure, don't reason to it).

### 2.4 Prior art in geocoding/address validation for "confidently wrong assembly"

- **Toponym resolution** is the named research problem containing your failure (GeoNames has 60+ "Paris"es). Standard implementation: **population prior** (CamCoder and others use candidate population as an explicit feature), **spatial minimality** (co-occurring toponyms should cluster; pick the candidate minimizing distance to the cluster), one-referent-per-discourse, and voting/ensemble disambiguators (2023). [S] "Weimar, Thüringen" → Weimar-TX is a textbook violation of _both_ context-toponym use and spatial minimality: the input's other toponym was discarded rather than used as a disambiguation constraint. The literature's first-line answer is exactly your rung 0: a co-mentioned admin unit is a hard filter, not a tiebreaker.
- **Industry address validation**: the commercial stack decomposes the answer per level — USPS **DPV** as an _independent_ deliverability oracle; Google's Address Validation reporting per-component confirmation levels (confirmed / unconfirmed-but-plausible / suspicious); geocoder confidence + precision codes (rooftop vs interpolated vs centroid); plus blunt sanity checks (coordinates in an ocean / wrong country). [S for the landscape; Google's exact confirmation-level enum names are M] The transferable pattern: **per-component verdicts against reference data**, not one scalar confidence — your checker should say "locality confirmed, region contradicted", which is also the actionable form for a re-query.
- **Record-linkage QA**: Fellegi–Sunter (which `packages/match` already implements) natively defines the upper/lower-threshold **clerical-review band** — the trichotomy (accept / review / reject) is the century-old shape of "flag the confidently wrong for a second look". [M — textbook]
- **KB consistency checking**: SDValidate/SDType (2.3), relation-assertion error detection with induced constraints (Melo & Paulheim 2017/2020), path-ranking-guided embeddings for noisy-KG error detection. [S]
- I found **no published work naming the exact compound failure** — "parser right, assembler wrong, joint assembly implausible, nothing flagged" — as its own problem; the pieces live in toponym resolution (the disambiguation failure) and KB error detection (the joint-implausibility detector). [S — absence claim, bounded by my searches]

---

## Synthesis for the design decision

1. **Do not build an auto-decoder.** Right intuition (explanation difficulty = anomaly), wrong cost profile (per-record optimization loop), and no published precedent on structured records; masked modeling is the same signal amortized.
2. **The observed failure dies at rung 0.** A containment check — parsed region/country evidence vs. the assembled locality's WOF ancestry — is deterministic, gazetteer-native, and free. Ship that before any model.
3. **Rung 1 next**: p(parent | child) as literal hierarchy-table lookups, SDValidate-style thresholds; add smoothing/backoff only where sparsity actually bites (measure first).
4. **If a learned checker is built** (masked-field model over assembled records, MCM/TURL-shaped, reusing the BIO masking infra): train it on gazetteer + corpus records — _never_ on resolver outputs (confirmation-bias literature is unanimous) — and audit it with adversarial validation + round-trip consistency through the formatter, both of which are nearly free given existing packages.
5. **Emit per-component verdicts**, not a scalar score — the industry-validated, actionable shape.

## Claims register

**Verified by search this session**: DeepSDF auto-decoder mechanism + two-phase latent optimization; Tan & Mavrovouniotis 1995 as DeepSDF's cited origin (via secondary citation); GLO's encoder-less framing and per-sample latents; implicit-field auto-decoder anomaly detection in medical imaging (arXiv 2106.05214); auto-decoding neural fields active through 2026 + latents-hard-to-classify finding; MCM ICLR 2024 (mechanism + SOTA claim); TURL Masked Entity Recovery; SPENs; energy-based NMT reranking; Arazo et al. confirmation bias + mitigations; entity-alignment confirmation-bias paper; LLM self-preference bias (incl. judges favoring models trained on judge-generated data); Alberti et al. round-trip consistency + its adoption; adversarial validation method + AUC interpretation; SDValidate mechanism + usage-over-axioms property; HoloClean's unified signals; Mudgal SIGMOD 2018 existence; Ditto +29% F1; toponym-resolution heuristics (population prior, spatial minimality, CamCoder features, 60+ Parises); industry validation landscape (DPV independence, confidence/precision codes, per-level accuracy).

**From memory (not re-verified)**: exact Tan & Mavrovouniotis 1995 paper title; MAE = He et al. 2022 and the masked-autoencoder mechanics; DeepSDF slow-inference critique + amortization follow-ons; Mudgal's specific structured-vs-textual/dirty breakdown; Google Address Validation confirmation-level enum; Fellegi–Sunter clerical band; Leidner's one-referent-per-discourse attribution.

**Absence claims (bounded by this session's searches)**: no auto-decoder line for tabular/structured-record anomaly detection; no paper naming the "parser right, assembly implausible" compound failure as its own problem.

## Primary sources

- DeepSDF: https://arxiv.org/abs/1901.05103 (mechanism confirmed via secondary sources incl. https://karan3-zoh.medium.com/paper-summary-deepsdf-learning-continuous-signed-distance-functions-for-shape-representation-147af4740485, https://parkcheolhee-lab.github.io/deep-sdf/)
- GLO: https://openreview.net/pdf?id=ryj38zWRb ; https://ameroyer.github.io/portfolio/2017-10-12-glo/
- Implicit-field anomaly detection: https://arxiv.org/pdf/2106.05214
- Neural-field auto-decoding 2025/26 survey context: https://arxiv.org/pdf/2606.08204 ; https://arxiv.org/pdf/2412.08731
- MCM: https://openreview.net/forum?id=lNZJyEDxy4 ; https://proceedings.iclr.cc/paper_files/paper/2024/file/13ec20547d2b1ff3a3a7a7c68a28e742-Paper-Conference.pdf
- TURL: https://arxiv.org/pdf/2006.14806
- SPEN: https://arxiv.org/abs/1511.06350
- Arazo confirmation bias: https://arxiv.org/abs/1908.02983
- Entity-alignment confirmation bias: https://arxiv.org/pdf/2307.02075
- Round-trip consistency: https://aclanthology.org/P19-1620/ ; https://arxiv.org/abs/1906.05416
- Adversarial validation: https://arxiv.org/pdf/2112.10078 ; https://apxml.com/courses/monitoring-managing-ml-models-production/chapter-2-advanced-drift-detection/adversarial-validation-drift
- SDValidate / KG refinement: https://journals.sagepub.com/doi/10.3233/SW-160218 ; http://www.heikopaulheim.com/docs/kcap2017.pdf
- HoloClean: https://arxiv.org/pdf/1702.00820
- Entity matching: https://pages.cs.wisc.edu/~anhai/papers1/deepmatcher-sigmod18.pdf ; https://dl.acm.org/doi/abs/10.14778/3421424.3421431
- Toponym disambiguation: https://www.sciencedirect.com/science/article/pii/S1569843223000134 ; https://aclanthology.org/2023.starsem-1.6.pdf
- Industry validation: https://developers.google.com/maps/architecture/geocoding-address-validation ; https://www.ecopiatech.com/resources/blog/geocoding-accuracy-indicators
