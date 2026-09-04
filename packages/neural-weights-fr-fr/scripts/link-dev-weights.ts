#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the fr-fr overlay's dev artifacts. The steps live in
 *   `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`; this file is the manifest.
 *
 *   #1179 OVERLAY FORM: fr-fr declares `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"`, so
 *   `resolveWeights` falls through to the en-us package for `model.onnx` / `tokenizer.model` / the card. This overlay
 *   therefore links no model or tokenizer — it REMOVES any leftover local pair so the base fallback engages. (An
 *   earlier version re-symlinked a pinned v241-fr-nsplice model on every `yarn test`; once the overlay form landed
 *   that local file SHADOWED the base fallback, silently running the stale model for every dev fr-fr parse, and its
 *   #397 md5 guard could never pass against the en-us card. One model, one pin — en-us's manifest owns it.)
 *
 *   What fr-fr DOES own locally (`resolveFromPackageDir` resolves these from the overlay dir with no base fallback):
 *
 *   - `anchor-lexicon-v1.json` / `country-surface-lexicon-v1.json` — checked-in repo files.
 *   - `street-type-lexicon-v*.json` / `locality-surface-lexicon-v*.json` — the evidence lexicons, by the generation
 *       the card names under `requires.<channel>.lexicon`, the same pair the `files` array ships.
 *   - `postcode-fr.bin` — derived from the WOF intl postcode extract (`softFeed.postcodeDBByCountry.fr` =
 *       postalcode-intl.db), built skip-if-present. Without it a fresh worktree parses anchor-OFF.
 *   - `pair-index-fr.bin` (hierarchy campaign R6) — built from the raw BAN dump through the shared
 *       `buildPairIndexOverlay`. The FR source is BAN's `nom_ld` (lieu-dit), read through `ban/sdk`'s `cleanLieuDit`
 *       — NOT WOF (WOF's French neighbourhood records are Paris quartiers, which never appear in a postal address).
 *       BAN is a directory of 101 département files, so the guard md5s nothing (hashing all of them costs more than
 *       it saves; a BAN refresh is a deliberate act — delete the artifact after one) and instead refuses an
 *       implausibly SMALL artifact: the BAN-derived index is ~6 MB, while a pair index built here from the WRONG
 *       source (the admin-DB borough recipe) is ~1.9 kB with matching magnitudes. The calibrated magnitudes are the
 *       R6 bars' (board 0/80 → 76/80, 0/60 confound FPs); the parent-bias δ=5 leg is the one that CAUGHT the
 *       whole-edge mechanism's real defect — see `docs/records/evals/2026-08-04-pix1-whole-edge-verdict.md`.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import {
	committedSoftFeedLinks,
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_PARENT_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

/**
 * Raw BAN dump the lieu-dit pairs are extracted from — a DIRECTORY, so it rides `inputs` (existence only), not
 * `sources` (md5).
 */
const BAN_DIR = String(dataRootPath("corpus", "sources", "ban"))

const softFeed = await committedSoftFeedLinks()

await materializeDevOverlay({
	locale: "fr-fr",
	model: { kind: "inherit" },
	softFeed: [softFeed.anchor, softFeed.country],
	evidenceLexiconsFromCard: true,
	postcodeBinary: { country: "fr", database: String(dataRootPath("wof", "postalcode-intl.db")) },
	pairIndex: {
		country: "fr",
		delta: PAIR_INDEX_DELTA,
		transitionBeta: PAIR_INDEX_TRANSITION_BETA,
		parentDelta: PAIR_INDEX_PARENT_DELTA,
		sources: [],
		inputs: [BAN_DIR],
		extraArgs: ["--ban-dir", BAN_DIR],
		minimumPlausibleBytes: 1_000_000,
	},
	localeFST: true,
	streetMorphologyFST: true,
})
