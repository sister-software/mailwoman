#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the en-nz overlay's dev artifacts. The steps live in
 *   `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`; this file is the manifest.
 *
 *   #1179 OVERLAY FORM: en-nz declares `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"`, so
 *   `resolveWeights` falls through to the en-us package for `model.onnx` / `tokenizer.model`. This overlay links no
 *   model or tokenizer — it REMOVES any leftover local pair so the base fallback engages (a stale local file would
 *   SHADOW the base fallback and silently serve outdated bytes; the fr-fr manifest's header records the incident).
 *
 *   What en-nz DOES own locally (`resolveFromPackageDir` resolves these from the overlay dir with no base fallback):
 *
 *   - `anchor-lexicon-v1.json` / `country-surface-lexicon-v1.json` — checked-in repo files.
 *   - `street-type-lexicon-v*.json` / `locality-surface-lexicon-v*.json` — the evidence lexicons, by the generation
 *       the card names under `requires.<channel>.lexicon`, the same pair the `files` array ships.
 *   - `pair-index-nz.bin` (NZ arc, #1277) — no committed source (derived from the LINZ-derived OpenAddresses NZ
 *       countrywide CSV, the same register `synth-nz-v2` was built from), built through the shared
 *       `buildPairIndexOverlay` (whose freshness guard compares the format, every calibrated magnitude, and the
 *       source md5; sidecar-cached — the CSV is 2.12M rows). `--delta 10` is the NZ-sweep-calibrated value (saturates
 *       at δ=10, identical to 12/15, 0/54 golden-FP throughout) baked into the artifact's header. This locale
 *       deliberately ships WITHOUT a `transitionBeta` (unmeasured there); the parent-bias δ=5 is measured — NZ's own
 *       shipped board moved 230/246 → 246/246 whole-edge, identical at δ 4/6/8/20 — see
 *       `docs/records/evals/2026-08-04-pix1-whole-edge-verdict.md`.
 *
 *   UNLIKE en-gb there is NO postcode binary to build: no WOF NZ postcode extract exists (release.config.json's
 *   softFeed.postcodeDBByCountry has no `nz` entry), so the anchor channel resolves OFF for en-nz until that extract
 *   is built — the tracked follow-up in this package's model-card.json (`nz_artifacts.no_postcode_bin`).
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import {
	committedSoftFeedLinks,
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_PARENT_DELTA,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

/**
 * The LINZ-derived OpenAddresses NZ countrywide CSV — the build's one source, md5-recorded in the header.
 */
const NZ_SOURCE_CSV = String(dataRootPath("openaddresses", "extracted", "nz", "countrywide.csv"))

const softFeed = await committedSoftFeedLinks()

await materializeDevOverlay({
	locale: "en-nz",
	model: { kind: "inherit" },
	softFeed: [softFeed.anchor, softFeed.country],
	evidenceLexiconsFromCard: true,
	pairIndex: {
		country: "nz",
		delta: PAIR_INDEX_DELTA,
		parentDelta: PAIR_INDEX_PARENT_DELTA,
		sources: [NZ_SOURCE_CSV],
		extraArgs: ["--source", NZ_SOURCE_CSV],
	},
	streetMorphologyFST: true,
})
