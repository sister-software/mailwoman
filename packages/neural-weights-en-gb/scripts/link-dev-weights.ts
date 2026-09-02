#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Symlink dev model + tokenizer files into this package for local testing.
 *   See @mailwoman/neural-weights-en-us/scripts/link-dev-weights.ts for the rationale.
 *
 *   A single multilingual model serves both en-us and en-gb (byte-identical artifact;
 *   en-gb carries its own retrieval data on top). Re-symlinks the SAME files
 *   as en-us until per-locale training lands. Keep these defaults in lockstep with en-us's
 *   DEFAULT_* on every ship. The md5 guard reads en-us's model-card `files_md5` — one truth
 *   for the one artifact (en-gb's own card carries no files_md5 block).
 *
 *   ALSO links the soft-feed siblings a fresh worktree is otherwise missing (the
 *   fresh-worktree gazetteer-OFF gap: `link-dev-weights.ts` historically symlinked only
 *   model+tokenizer, leaving `anchor-lexicon-v1.json` / `country-surface-lexicon-v1.json`
 *   absent — the CLI then parses gazetteer-OFF with only a stderr warning). Both lexicons are
 *   checked-in repo files (`data/gazetteer/…`), so they're symlinked straight from there.
 *
 *   ALSO links the OPTION-A EVIDENCE LEXICONS (#1511), which this overlay went without for its whole
 *   life. The card claims its `requires` block is a verbatim copy of the base's, and the base model is
 *   trained WITH `street_type` + `locality_surface` — but the copy silently dropped both channels, so
 *   a GB parse ran them off on a model that expects them. The generation linked for each comes from
 *   the CARD (`requires.<channel>.lexicon`), not a literal in this file, so bumping the card moves the
 *   artifact with it. `street-type-lexicon-v*.json` is committed under `data/gazetteer/`;
 *   `locality-surface-lexicon-v*.json` is 7-13 MB and lives in the data root under `gazetteer/`.
 *
 *   `postcode-gb.bin` is CARD-CONDITIONAL, and that condition is the interesting decision in this file — the
 *   full reasoning sits at the build step below. Short version: the binary helps only a model whose
 *   encoder actually trained on letter-bearing GB anchor keys, and the card says whether this is one
 *   (`requires.anchor.span_mode === "shaped"`). Declared → build it from the licence-clean Code-Point
 *   Open extract. Not declared → remove any stale copy, because a leftover from an older checkout is
 *   found package-dir-relative and silently restores a measured 24-postcode regression with no
 *   warning. Receipts: `docs/records/evals/2026-08-05-en-gb-anchor-off.md` (anchor-OFF mitigation,
 *   #1467) and `docs/records/evals/2026-08-05-v420-base-anchor-v2-run-b.md` (the retrain that earns it
 *   back), plus this package's `model-card.json` → `gb_artifacts.no_postcode_bin`.
 *
 *   ALSO builds `pair-index-gb.bin` (placetype-pair-prior arc) the same way: no committed source
 *   (derived from the HM Land Registry PPD tuples CSV + the WOF admin DB + three checked-in pairs
 *   JSONLs), built in place via the compiled `gazetteer pair-index` CLI through the shared
 *   `buildPairIndexOverlay`, whose freshness guard compares the format, EVERY calibrated magnitude,
 *   and EVERY source md5 (sidecar-cached — the PPD CSV is ~25.6M rows, a cold build is ~4-5 min, and
 *   `weights.test.ts` invokes this script on every `yarn test`). The original δ calibration
 *   (2026-07-22, feed-8k checkpoint — that checkpoint choice is FINAL) is recorded in this file's git
 *   history; the shipped bundle re-tuned δ to 10 (#1269).
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { $public } from "@mailwoman/core/env"
import { pathExists, readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePath } from "@mailwoman/core/fs/writers"
import { md5Hex } from "@mailwoman/core/hash"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { spawnProcessSync } from "@mailwoman/core/process"
import { weightsOverlayPath } from "@mailwoman/core/utils"
import {
	buildPairIndexOverlay,
	linkForce,
	linkLocaleFST,
	linkSoftFeedSibling,
	linkStreetMorphologyFST,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_PARENT_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"
import { resolvePath } from "path-ts"

/**
 * Workspace root the artifacts are linked into. Everything below resolves against it.
 */
const PKG_DIR = workspacePath("neural-weights-en-gb")
/**
 * Where the artifacts LAND — the data-root overlay, never this tracked package.
 *
 * The binaries are not in git, so materializing them here made a fresh worktree unable to geocode, made `yarn test`
 * mutate a tracked directory as a side effect, and put a symlink into a publish tarball (`YN0035`). PKG_DIR stays for
 * what IS committed and must be read from the checkout.
 */
const DEST_DIR = String(weightsOverlayPath("en-gb"))

await makeDirectories(DEST_DIR)

/**
 * In lockstep with en-us's DEFAULT_* (one multilingual artifact serves both) — keep this pair identical to
 * neural-weights-en-us/scripts/link-dev-weights.ts's DEFAULT_MODEL / DEFAULT_TOKENIZER on every ship. The guard below
 * fails loud on any future miss.
 */
const SRC_MODEL =
	$public.MAILWOMAN_DEV_MODEL ||
	dataRootPath("models", "quantized", "model-v440-suffix-boundary-v2-step-060000-int8.onnx")

/**
 * Tokenizer actually linked — the environment override if set, otherwise the card's default.
 */
const SRC_TOKENIZER =
	$public.MAILWOMAN_DEV_TOKENIZER || dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")

if (!(await pathExists(SRC_MODEL))) {
	console.error(`missing source model: ${SRC_MODEL}`)

	process.exit(1)
}

if (!(await pathExists(SRC_TOKENIZER))) {
	console.error(`missing source tokenizer: ${SRC_TOKENIZER}`)

	process.exit(1)
}

/**
 * The BASE package's card, read from the checkout because it is committed. Not from `DEST_DIR` — walking up from the
 * overlay lands in the data root, which is where an earlier version of this migration pointed it.
 */
const BASE_CARD_PATH = resolvePath(String(workspacePath("neural-weights-en-us")), "model-card.json")

await linkForce(SRC_MODEL, resolvePath(DEST_DIR, "model.onnx"))
await linkForce(SRC_TOKENIZER, resolvePath(DEST_DIR, "tokenizer.model"))

console.log(`linked ${DEST_DIR}/{model.onnx,tokenizer.model}`)

// #397 guard, lockstep form: the en-gb artifact IS the en-us artifact, so verify the
// linked default bytes against en-us's model-card `files_md5` (skipped under an
// explicit MAILWOMAN_DEV_* override — deliberate experimentation).
if (!$public.MAILWOMAN_DEV_MODEL || !$public.MAILWOMAN_DEV_TOKENIZER) {
	const enUSCard = await readLocalJSONFile<{ files_md5?: Record<string, string> }>(BASE_CARD_PATH)

	const checks: Array<[string, string, string | undefined]> = [
		["model", resolvePath(DEST_DIR, "model.onnx"), enUSCard.files_md5?.["model.onnx"]],
		["tokenizer", resolvePath(DEST_DIR, "tokenizer.model"), enUSCard.files_md5?.["tokenizer.model"]],
	]

	for (const [label, path, expected] of checks) {
		if (
			($public.MAILWOMAN_DEV_MODEL && label === "model") ||
			($public.MAILWOMAN_DEV_TOKENIZER && label === "tokenizer")
		)
			continue

		if (!expected) {
			console.error(
				`ERROR (#397 guard): en-us model-card.json has no files_md5 entry for ${label} — cannot verify the dev pin.`
			)

			process.exit(1)
		}

		const actual = md5Hex(await readLocalBuffer(path))

		if (actual !== expected) {
			console.error(
				`ERROR (#397 guard): linked default ${label} md5 ${actual} != shipped ${expected} (en-us card files_md5).`
			)
			console.error("  Bump this script's SRC_* defaults in lockstep with en-us on each ship.")

			process.exit(1)
		}
	}
}

// --- soft-feed siblings (the fresh-worktree anchor-OFF gap) -----------------------------

/**
 * The gazetteer + country soft-feed lexicons are checked-in repo files — symlink straight from `data/gazetteer/` (the
 * same source `release.config.json`'s `softFeed.gazetteerLexicon` / `softFeed.countryLexicon` name, and what
 * `scripts/copy-weights.ts` copies verbatim at publish time).
 */
await linkSoftFeedSibling(
	repoRootPath("data", "gazetteer", "anchor-lexicon-v1.json"),
	resolvePath(DEST_DIR, "anchor-lexicon-v1.json"),
	"gazetteer channel will resolve OFF in this worktree."
)

await linkSoftFeedSibling(
	repoRootPath("data", "gazetteer", "country-surface-lexicon-v1.json"),
	resolvePath(DEST_DIR, "country-surface-lexicon-v1.json"),
	"country channel will resolve OFF in this worktree."
)

// --- evidence-bundle lexicons (#1511) ---------------------------------------------------
//
// The card declares both evidence channels, and the generation each names is what gets linked: the
// filenames come from the CARD, not from a literal here, so a card bump moves the artifact with it
// (#1510). Sources differ, and the asymmetry is not an oversight: `street-type-lexicon-v*.json` is
// small and COMMITTED (`data/gazetteer/`); `locality-surface-lexicon-v*.json` is 7-13 MB and never in
// git, so it lives in the data root under `gazetteer/`. Both mirror what `release.config.json`'s
// `softFeed.streetTypeLexicon` / `softFeed.localitySurfaceLexicon` name for the publish path.

/**
 * The generation of each evidence lexicon this overlay's card declares, and where that file is found. A card that names
 * nothing links nothing — silence beats guessing a generation the model may not have trained against.
 */
const EVIDENCE_LEXICONS: Array<{ channel: "street_type" | "locality_surface"; source: (name: string) => string }> = [
	{ channel: "street_type", source: (name) => repoRootPath("data", "gazetteer", name) },
	{ channel: "locality_surface", source: (name) => String(dataRootPath("gazetteer", name)) },
]

const CARD = (await readLocalJSONFile(resolvePath(PKG_DIR, "model-card.json"))) as {
	requires?: Record<string, { lexicon?: string; span_mode?: string } | undefined>
}

for (const { channel, source } of EVIDENCE_LEXICONS) {
	const declared = CARD.requires?.[channel]?.lexicon

	if (!declared) {
		console.error(`WARNING: model-card declares no requires.${channel}.lexicon — the ${channel} channel stays OFF.`)

		continue
	}

	await linkSoftFeedSibling(
		source(declared),
		resolvePath(DEST_DIR, declared),
		`the ${channel} channel will resolve OFF in this worktree.`
	)
}

/**
 * Compiled CLI used to run the build steps below. Requires `yarn compile` to have run.
 */
const CLI = workspacePath("mailwoman", "out", "cli.js")

// --- postcode-gb.bin: CARD-CONDITIONAL, not unconditional -------------------------------------
//
// The GB anchor binary is the one artifact whose correctness depends on WHICH MODEL is loaded, so it
// is built only when the card says the model can use it.
//
// The history in one paragraph. This script used to build the bin unconditionally. #1467 removed it,
// because the encoder's GB anchor slot (slot 4 of `LOCALE_ORDER`, `neural/anchor-inference.ts`) had
// taken no gradient — every recipe's `anchor_lookup_path` was `pilot-anchor-lookup.json`, 67,708 keys,
// zero letter-bearing, US/DE/FR only. Feeding slot 4 on a model that never trained it cost 24 exact
// postcodes on the 120-row gb-golden board (294/318 anchor-ON vs 318/318 anchor-OFF). Then a bare
// `existsSync` skip turned out to be worse than never building: a bin left by an older checkout is
// found package-dir-relative and silently re-enables the regression with no warning, because a present
// artifact is exactly what the loader expects.
//
// The check that resolves both states is the CARD's `requires.anchor.span_mode`. `shaped` is declared
// only by a model trained against a lookup with letter-bearing keys (`pilot-anchor-lookup-v2` and
// after), and that is precisely the model for which the bin helps. So: declared `shaped` → build it;
// anything else → remove any stale copy, loudly. No flag, no lockstep constant to forget — the same
// card the loader reads decides.
//
// Receipts either way: `docs/records/evals/2026-08-05-en-gb-anchor-off.md` (the anchor-OFF mitigation)
// and `docs/records/evals/2026-08-05-v420-base-anchor-v2-run-b.md` (the retrain that earns it back).

/**
 * Where the GB anchor binary lives when the card earns it.
 */
const POSTCODE_BIN_DEST = resolvePath(DEST_DIR, "postcode-gb.bin")

/**
 * The licence-clean GB postcode source: Ordnance Survey Code-Point Open (OGL v3.0), 1,746,976 units, every one placed.
 * The retired GeoNames-lineage `postalcode-gb.db` is NOT it. Coverage gap, measured: zero Northern Ireland (`BT`) codes
 * — the shaped keyer's outward fallback is what carries those rows.
 */
const GB_POSTCODE_EXTRACT = "postalcode-gb-codepoint.db"

/**
 * Keys the built binary must carry (1,746,976 units + 2,863 outward districts) — the GB half of the training lookup
 * `pilot-anchor-lookup-v2` verbatim. `gazetteer postcode-binary` enforces its own floor and exits nonzero below it, so
 * this number is documentation rather than a second check.
 */
const GB_POSTCODE_BIN_KEYS = 1_749_839

if (CARD.requires?.anchor?.span_mode === "shaped") {
	console.log(
		`model-card declares requires.anchor.span_mode "shaped" — building postcode-gb.bin ` +
			`(${GB_POSTCODE_BIN_KEYS.toLocaleString()} keys expected from ${GB_POSTCODE_EXTRACT})`
	)

	const built = spawnProcessSync(
		process.execPath,
		[CLI, "gazetteer", "postcode-binary", "--out", DEST_DIR, "--locale", `GB:${GB_POSTCODE_EXTRACT}`],
		{ stdio: "inherit" }
	)

	if (built.status !== 0) {
		console.error(`WARNING: gazetteer postcode-binary failed — the GB anchor channel will resolve OFF here.`)
	}
} else if (await pathExists(POSTCODE_BIN_DEST)) {
	await removePath(POSTCODE_BIN_DEST)

	console.log(
		`removed stale ${POSTCODE_BIN_DEST} — this card does not declare span_mode "shaped", so the bin's ` +
			`unit keys are unreachable and feeding slot 4 is a measured regression (see the block comment)`
	)
}

/**
 * Secondary pair sources (campaign R2/R3/R4b). Named here rather than inline at the call site because the freshness
 * guard has to md5 the SAME files the build reads — when those two lists drift apart the guard silently blesses a stale
 * artifact, which is exactly what happened before 2026-08-01.
 */
const PPD_SOURCE_CSV = String(dataRootPath("ppd", "2026-07-22", "gb-tuples.csv"))
const BOROUGH_DB = String(dataRootPath("wof", "admin-global-priority.db"))
const LONDON_PAIRS_JSONL = repoRootPath("data", "gazetteer", "london-pairs-v2.jsonl")
/**
 * Northern Ireland neighbourhood pairs (campaign R7). A SEPARATE file rather than merged into the London one, so each
 * source keeps its own provenance md5 in the header and the freshness guard can tell which of them moved.
 */
const NI_PAIRS_JSONL = repoRootPath("data", "gazetteer", "ni-pairs-v1.jsonl")
/**
 * Scotland + Wales + England neighbourhood pairs (campaign R8) — the rest of Great Britain, after London (R3/R4b) and
 * Northern Ireland (R7).
 */
const GB_REGIONS_JSONL = repoRootPath("data", "gazetteer", "gb-regions-v1.jsonl")

// Hierarchy campaign R2+R3: the WOF borough pairs + the checked-in ONSPD London ward pairs join the
// build — without these flags a dev rebuild would silently DROP them. The `sources` list is what the
// shared freshness guard md5s, in the order the build records them (CSV, borough DB, pairs JSONLs).
await buildPairIndexOverlay({
	packageDir: "neural-weights-en-gb",
	country: "gb",
	delta: PAIR_INDEX_DELTA,
	transitionBeta: PAIR_INDEX_TRANSITION_BETA,
	parentDelta: PAIR_INDEX_PARENT_DELTA,
	sources: [PPD_SOURCE_CSV, BOROUGH_DB, LONDON_PAIRS_JSONL, NI_PAIRS_JSONL, GB_REGIONS_JSONL],
	inputs: [PPD_SOURCE_CSV],
	extraArgs: [
		"--source",
		PPD_SOURCE_CSV,
		"--borough-db",
		BOROUGH_DB,
		"--pairs-jsonl",
		[LONDON_PAIRS_JSONL, NI_PAIRS_JSONL, GB_REGIONS_JSONL].join(","),
	],
})

await linkLocaleFST(DEST_DIR, "en-gb")
await linkStreetMorphologyFST(DEST_DIR)
