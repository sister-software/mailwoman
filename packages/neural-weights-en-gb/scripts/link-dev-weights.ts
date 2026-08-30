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
 *   `postcode-gb.bin` is CARD-GATED, and that gate is the interesting decision in this file — the
 *   full reasoning sits at the build step below. Short version: the binary helps only a model whose
 *   encoder actually trained on letter-bearing GB anchor keys, and the card says whether this is one
 *   (`requires.anchor.span_mode === "shaped"`). Declared → build it from the licence-clean Code-Point
 *   Open shard. Not declared → remove any stale copy, because a leftover from an older checkout is
 *   found package-dir-relative and silently restores a measured 24-postcode regression with no
 *   warning. Receipts: `docs/records/evals/2026-08-05-en-gb-anchor-off.md` (anchor-OFF mitigation,
 *   #1467) and `docs/records/evals/2026-08-05-v420-base-anchor-v2-run-b.md` (the retrain that earns it
 *   back), plus this package's `model-card.json` → `gb_artifacts.no_postcode_bin`.
 *
 *   ALSO builds `pair-index-gb.bin` (placetype-pair-prior arc) the same way: no
 *   committed source (derived from the HM Land Registry PPD tuples CSV), built in place via
 *   the compiled `gazetteer pair-index` CLI. The δ it builds with is {@link PAIR_INDEX_DELTA} — the
 *   single source of truth, matched against the existing binary's header by the freshness guard
 *   below; the shipped bundle re-tuned it to 10 (#1269). The original calibration (2026-07-22, δ =
 *   5.0) swept δ ∈ {3,4,4.5,5,6,7} against
 *   ~2k held-out PPD-tail register rows (dependent_locality tag-correct recall) and the 6,500-row
 *   FSA venue-confound board (FP), for BOTH ship-candidate checkpoints (feed-2k, feed-8k) — the
 *   two calibrate to DIFFERENT optima (feed-2k → 4.5, feed-8k → 5.0). The artifact is
 *   feed-8k-calibrated: the operator ratified feed-8k as the ship checkpoint (2026-07-23) over
 *   feed-2k (which fails the FR-fragment `bare-locality` hallucination bar outright, 0.665 vs
 *   ≥0.90 — the same early-training-collapse shape as the sibling en-gb-locale-arc's probe-2
 *   checkpoint). That checkpoint choice is FINAL, not open.
 *   **What actually blocks promotion is the Gauntlet**, not the checkpoint
 *   pick: feed-8k FAILS the metamorphic layer (loses the "1600 Pennsylvania Ave NW" comma-drop
 *   rooftop resolution; v385 holds it), and a same-day repair attempt
 *   (`v3.11.1-deploc-consolidate`) came back NOT CLEAN — STOP RULE EXECUTED, the v3.11.x lineage
 *   is CLOSED for shipping. This artifact (feed-8k-calibrated) stays correct and ready
 *   regardless — the prior composes with whatever model eventually ships. Path forward: v3.12
 *   (`docs/superpowers/plans/2026-07-23-v312-comma-robust-recipe.md`, operator-gated redesign).
 *
 *   FRESHNESS GUARD on the skip-if-exists path: a bare `existsSync` skip would be wrong here —
 *   an existing `pair-index-gb.bin` could be stale against either (a) a bumped `--delta`
 *   literal below (the #397-guard-style md5-lockstep discipline the model/tokenizer check above
 *   already uses, applied to this artifact) or (b) a changed PPD source CSV on disk. Mirrors that
 *   SAME md5-lockstep pattern: peek the existing binary's header (magic + header block ONLY, via
 *   `peekPairIndexHeader` — reimplemented locally, not imported from `@mailwoman/neural`, so this
 *   data-only package doesn't gain a dependency on the ONNX-runtime-carrying workspace for one
 *   header read) and compare `header.delta` against this script's own `PAIR_INDEX_DELTA` const,
 *   `header.transitionBeta` against `PAIR_INDEX_TRANSITION_BETA` (same lockstep discipline —
 *   TRANSITION-BETA build, 2026-07-24; an absent field on an old binary reads `undefined` and
 *   forces the rebuild that stamps it in), and `header.sourceMD5s[0]` (the md5 the artifact was actually built from, per
 *   `pair-index.tsx`'s own self-recorded provenance) against a freshly computed md5 of the CURRENT
 *   PPD source CSV. Either mismatch forces a loud rebuild instead of a silent skip.
 */

import { $public } from "@mailwoman/core/env"
import { readLocalTextFile, statPath, pathExists, readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile, makeDirectories, removePath } from "@mailwoman/core/fs/writers"
import { dataRootPath, md5File, repoRootPath, weightsOverlayPath, workspacePath } from "@mailwoman/core/utils"
import { spawnSync } from "@mailwoman/platform/child_process"
import { createHash } from "@mailwoman/platform/crypto"
import { resolve } from "@mailwoman/platform/path"
import {
	linkForce,
	pairIndexStaleReason,
	peekPairIndexHeaderFields,
	warnIfFSTStale,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

/**
 * Hex characters in an md5 digest.
 */
const MD5_HEX_LENGTH = 32

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
 * Read or compute MD5 hash for a file, using a sidecar .md5 cache to avoid re-hashing large files. The sidecar is
 * written in standard md5sum format: `<hash> <filename>` (hash, two spaces, filename). On subsequent runs, if the
 * sidecar exists and its mtime >= the source file's mtime, the hash is read from the sidecar; otherwise it's recomputed
 * and the sidecar is updated.
 */
async function md5FileWithSidecar(path: string): Promise<string> {
	const sidecarPath = `${path}.md5`
	const sourceStats = await statPath(path)

	if (await pathExists(sidecarPath)) {
		try {
			const sidecarStats = await statPath(sidecarPath)

			if (sidecarStats.mtime >= sourceStats.mtime) {
				const sidecarContent = (await readLocalTextFile(sidecarPath)).trim()
				const [hash] = sidecarContent.split(/\s+/)

				if (hash && hash.length === MD5_HEX_LENGTH) {
					// Valid md5 hash (32 hex chars)
					console.log(`md5(${path}): read from sidecar`)

					return hash
				}
			}
		} catch {
			// If sidecar read fails, fall through to recompute
		}
	}

	const hash = await md5File(path)
	const filename = path.split(/[/\\]/).pop() || path
	await writeLocalTextFile(`${hash}  ${filename}\n`, sidecarPath)

	console.log(`md5(${path}): computed and cached in sidecar`)

	return hash
}

/**
 * The BASE package's card, read from the checkout because it is committed. Not from `DEST_DIR` — walking up from the
 * overlay lands in the data root, which is where an earlier version of this migration pointed it.
 */
const BASE_CARD_PATH = resolve(String(workspacePath("neural-weights-en-us")), "model-card.json")

linkForce(SRC_MODEL, resolve(DEST_DIR, "model.onnx"))
linkForce(SRC_TOKENIZER, resolve(DEST_DIR, "tokenizer.model"))

console.log(`linked ${DEST_DIR}/{model.onnx,tokenizer.model}`)

// #397 guard, lockstep form: the en-gb artifact IS the en-us artifact, so verify the
// linked default bytes against en-us's model-card `files_md5` (skipped under an
// explicit MAILWOMAN_DEV_* override — deliberate experimentation).
if (!$public.MAILWOMAN_DEV_MODEL || !$public.MAILWOMAN_DEV_TOKENIZER) {
	const enUSCard = await readLocalJSONFile<{ files_md5?: Record<string, string> }>(BASE_CARD_PATH)

	const checks: Array<[string, string, string | undefined]> = [
		["model", resolve(DEST_DIR, "model.onnx"), enUSCard.files_md5?.["model.onnx"]],
		["tokenizer", resolve(DEST_DIR, "tokenizer.model"), enUSCard.files_md5?.["tokenizer.model"]],
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

		const actual = createHash("md5")
			.update(await readLocalBuffer(path))
			.digest("hex")

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
const SRC_GAZETTEER_LEXICON = repoRootPath("data", "gazetteer", "anchor-lexicon-v1.json")
/**
 * Country-surface lexicon generated into the repo by the codex build.
 */
const SRC_COUNTRY_LEXICON = repoRootPath("data", "gazetteer", "country-surface-lexicon-v1.json")

if (await pathExists(SRC_GAZETTEER_LEXICON)) {
	linkForce(SRC_GAZETTEER_LEXICON, resolve(DEST_DIR, "anchor-lexicon-v1.json"))

	console.log(`linked ${DEST_DIR}/anchor-lexicon-v1.json`)
} else {
	console.error(`WARNING: missing ${SRC_GAZETTEER_LEXICON} — gazetteer channel will resolve OFF in this worktree.`)
}

if (await pathExists(SRC_COUNTRY_LEXICON)) {
	linkForce(SRC_COUNTRY_LEXICON, resolve(DEST_DIR, "country-surface-lexicon-v1.json"))

	console.log(`linked ${DEST_DIR}/country-surface-lexicon-v1.json`)
} else {
	console.error(`WARNING: missing ${SRC_COUNTRY_LEXICON} — country channel will resolve OFF in this worktree.`)
}

// --- evidence-bundle lexicons (#1511) ---------------------------------------------------
//
// This overlay's card claims to be a verbatim copy of the base declaration, and the base model is
// TRAINED with the Option-A evidence bundle — but the card omitted `street_type`/`locality_surface`
// and this script linked neither, so every GB parse ran both channels OFF on a model that expects
// them. The card now declares both, and the generation each names is what gets linked: the filenames
// come from the CARD, not from a literal here, so a card bump moves the artifact with it (#1510).
//
// Sources differ, and the asymmetry is not an oversight. `street-type-lexicon-v*.json` is small and
// COMMITTED (`data/gazetteer/`); `locality-surface-lexicon-v*.json` is 7-13 MB and never in git, so it
// lives in the data root under `gazetteer/`. Both mirror what `release.config.json`'s
// `softFeed.streetTypeLexicon` / `softFeed.localitySurfaceLexicon` name for the publish path.

/**
 * The generation of each evidence lexicon this overlay's card declares, and where that file is found. A card that names
 * nothing links nothing — silence beats guessing a generation the model may not have trained against.
 */
const EVIDENCE_LEXICONS: Array<{ channel: "street_type" | "locality_surface"; source: (name: string) => string }> = [
	{ channel: "street_type", source: (name) => repoRootPath("data", "gazetteer", name) },
	{ channel: "locality_surface", source: (name) => String(dataRootPath("gazetteer", name)) },
]

const CARD = (await readLocalJSONFile(resolve(PKG_DIR, "model-card.json"))) as {
	requires?: Record<string, { lexicon?: string; span_mode?: string } | undefined>
}

for (const { channel, source } of EVIDENCE_LEXICONS) {
	const declared = CARD.requires?.[channel]?.lexicon

	if (!declared) {
		console.error(`WARNING: model-card declares no requires.${channel}.lexicon — the ${channel} channel stays OFF.`)

		continue
	}

	const src = source(declared)

	if (await pathExists(src)) {
		linkForce(src, resolve(DEST_DIR, declared))

		console.log(`linked ${DEST_DIR}/${declared}`)
	} else {
		console.error(`WARNING: missing ${src} — the ${channel} channel will resolve OFF in this worktree.`)
	}
}

/**
 * Compiled CLI used to run the build steps below. Requires `yarn compile` to have run.
 */
const CLI = workspacePath("mailwoman", "out", "cli.js")

// --- postcode-gb.bin: CARD-GATED, not unconditional -------------------------------------
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
// The gate that resolves both states is the CARD's `requires.anchor.span_mode`. `shaped` is declared
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
const POSTCODE_BIN_DEST = resolve(DEST_DIR, "postcode-gb.bin")

/**
 * The licence-clean GB postcode source: Ordnance Survey Code-Point Open (OGL v3.0), 1,746,976 units, every one placed.
 * The retired GeoNames-lineage `postalcode-gb.db` is NOT it. Coverage gap, measured: zero Northern Ireland (`BT`) codes
 * — the shaped keyer's outward fallback is what carries those rows.
 */
const GB_POSTCODE_SHARD = "postalcode-gb-codepoint.db"

/**
 * Keys the built binary must carry (1,746,976 units + 2,863 outward districts) — the GB half of the training lookup
 * `pilot-anchor-lookup-v2` verbatim. `gazetteer postcode-binary` enforces its own floor and exits nonzero below it, so
 * this number is documentation rather than a second gate.
 */
const GB_POSTCODE_BIN_KEYS = 1_749_839

if (CARD.requires?.anchor?.span_mode === "shaped") {
	console.log(
		`model-card declares requires.anchor.span_mode "shaped" — building postcode-gb.bin ` +
			`(${GB_POSTCODE_BIN_KEYS.toLocaleString()} keys expected from ${GB_POSTCODE_SHARD})`
	)

	const built = spawnSync(
		process.execPath,
		[CLI, "gazetteer", "postcode-binary", "--out", DEST_DIR, "--locale", `GB:${GB_POSTCODE_SHARD}`],
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
 * `pair-index-gb.bin` (placetype-pair-prior arc) has no committed source either (it's derived from the HM Land Registry
 * PPD tuples CSV) — build it the same way, via the compiled `gazetteer pair-index` CLI. `PAIR_INDEX_DELTA` is held in
 * lockstep with the value baked into the real `neural-weights-en-gb/pair-index-gb.bin` header — see this file's header
 * comment for the calibration method and the current ship-blocker status (Gauntlet FAIL + stop rule executed, not the
 * checkpoint choice, which is settled at feed-8k). Skips with a warning (not a hard failure) so a worktree without the
 * PPD source CSV can still link everything else. The PPD tuples CSV is ~25.6M rows — a cold build takes several minutes
 * (measured 2026-07-22: ~4-5 min), which is why the freshness guard below exists at all. `weights.test.ts` invokes this
 * script on every `yarn test`/`yarn vitest` run (the #397-guard pattern), so REBUILDING UNCONDITIONALLY here would make
 * every test run pay that cost. Skip ONLY when the existing artifact is verifiably FRESH (see the FRESHNESS GUARD
 * module-doc paragraph above) — a stale skip would let a bumped delta or a changed PPD snapshot silently ship a
 * byte-identical-looking but out-of-date artifact into every test run.
 */
const PPD_SOURCE_CSV = dataRootPath("ppd", "2026-07-22", "gb-tuples.csv")
/**
 * Where the placetype pair index is written — a soft-feed sibling, absent in a lean install.
 */
const PAIR_INDEX_BIN_DEST = resolve(DEST_DIR, "pair-index-gb.bin")
/**
 * Decoder pair-index bonus baked into this artifact. Held in lockstep with the shipped binary's header — a mismatch
 * forces a loud rebuild rather than silently shipping a stale index.
 */
const PAIR_INDEX_DELTA = 10
/**
 * The GB artifact's decoder transition-entry bonus (TRANSITION-BETA build, 2026-07-24 — operator-approved β=5 from the
 * transition-level probe: 13/17 comma-free misses recovered, zero measured collateral). Held in lockstep with the
 * shipped header exactly like {@link PAIR_INDEX_DELTA}: a mismatch against the existing binary's header forces a loud
 * rebuild. NZ deliberately ships WITHOUT a beta (unmeasured there) — its link script has no counterpart const.
 */
const PAIR_INDEX_TRANSITION_BETA = 5
/**
 * The GB artifact's WHOLE-EDGE parent-bias magnitude (#46, default-on 2026-08-04). δ=5 is the verdict's recommendation:
 * the smallest magnitude that saturates bar B-2, with 0.00% parent-side false positives on B-3 and GB's own shipped
 * board moving 66/69 → 69/69 whole-edge. See `docs/records/evals/2026-08-04-pix1-whole-edge-verdict.md`. Held in
 * lockstep with the shipped header like the two magnitudes above.
 */
const PAIR_INDEX_PARENT_DELTA = 5

/**
 * Secondary pair sources (campaign R2/R3/R4b). Named here rather than inline at the call site because the freshness
 * guard has to md5 the SAME files the build reads — when those two lists drift apart the guard silently blesses a stale
 * artifact, which is exactly what happened before 2026-08-01.
 */
const BOROUGH_DB = dataRootPath("wof", "admin-global-priority.db")
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

let pairIndexIsFresh = false

if (await pathExists(PAIR_INDEX_BIN_DEST)) {
	try {
		const header = await peekPairIndexHeaderFields(PAIR_INDEX_BIN_DEST)
		const existingSourceMD5s = header.sourceMD5s

		// Format + every calibrated magnitude, through the shared check (`@mailwoman/resolver-wof-sqlite/weights-overlay-linker`) so a
		// new header field cannot be compared by some linkers and not others — which is how three of the four base
		// linkers ended up unable to notice a schema bump.
		const staleReason = pairIndexStaleReason(header, {
			delta: PAIR_INDEX_DELTA,
			transitionBeta: PAIR_INDEX_TRANSITION_BETA,
			parentDelta: PAIR_INDEX_PARENT_DELTA,
		})

		if (staleReason) {
			console.log(`STALE pair-index-gb.bin: ${staleReason} — rebuilding.`)
		} else if (!(await pathExists(String(PPD_SOURCE_CSV)))) {
			// Magnitudes match but the source CSV isn't on disk to re-hash — can't do better than trust that
			// match (the "missing source, can't build" branch below would fire anyway if this were stale and
			// needed a rebuild).
			pairIndexIsFresh = true

			console.log(
				`skipped pair-index-gb.bin build — ${PAIR_INDEX_BIN_DEST} has matching header magnitudes (source CSV absent, md5 freshness unverifiable)`
			)
		} else {
			// Compare EVERY source, not just the CSV. Checking `sourceMD5s[0]` alone leaves the guard blind
			// to the borough DB and the checked-in London pairs (the sources campaign R3/R4b added), so a stale
			// artifact built from an older pair set keeps reporting itself fresh and every local run (and the CI cache)
			// silently grades against it — that is how the TRANSITION-BETA pin row drifted unnoticed. The build writes
			// one md5 per source in order (CSV, borough DB, pairs JSONL), so a length mismatch is itself staleness:
			// an artifact predating a source cannot have recorded its md5.
			const currentSourceMD5s = [
				await md5FileWithSidecar(String(PPD_SOURCE_CSV)),
				await md5FileWithSidecar(String(BOROUGH_DB)),
				await md5FileWithSidecar(String(LONDON_PAIRS_JSONL)),
				await md5FileWithSidecar(String(NI_PAIRS_JSONL)),
				await md5FileWithSidecar(String(GB_REGIONS_JSONL)),
			]

			const matches =
				existingSourceMD5s.length === currentSourceMD5s.length &&
				currentSourceMD5s.every((md5, i) => md5 === existingSourceMD5s[i])

			if (matches) {
				pairIndexIsFresh = true

				console.log(
					`skipped pair-index-gb.bin build — ${PAIR_INDEX_BIN_DEST} is fresh (header magnitudes + all ${currentSourceMD5s.length} source md5s match)`
				)
			} else {
				console.log(
					`STALE pair-index-gb.bin: header source md5s [${existingSourceMD5s.join(", ") || "(none recorded)"}] != ` +
						`current [${currentSourceMD5s.join(", ")}] — rebuilding.`
				)
			}
		}
	} catch (error) {
		console.log(`pair-index-gb.bin header unreadable (${(error as Error).message}) — rebuilding.`)
	}
}

if (pairIndexIsFresh) {
	// Nothing to do — the loud skip/rebuild message was already printed above.
} else if (!(await pathExists(CLI))) {
	console.error(
		`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run this script to build pair-index-gb.bin.`
	)
} else if (!(await pathExists(String(PPD_SOURCE_CSV)))) {
	console.error(
		`WARNING: missing ${PPD_SOURCE_CSV} — pair-index-gb.bin not built; the placetype-pair prior default will resolve OFF for GB.`
	)
} else {
	const result = spawnSync(
		process.execPath,
		[
			CLI,
			"gazetteer",
			"pair-index",
			"--out",
			DEST_DIR,
			"--country",
			"gb",
			"--source",
			String(PPD_SOURCE_CSV),
			"--delta",
			String(PAIR_INDEX_DELTA),
			"--transition-beta",
			String(PAIR_INDEX_TRANSITION_BETA),
			"--parent-delta",
			String(PAIR_INDEX_PARENT_DELTA),
			// Hierarchy campaign R2+R3: the WOF borough pairs + the checked-in ONSPD London ward pairs
			// join the build — without these flags a dev rebuild would silently DROP them.
			"--borough-db",
			String(BOROUGH_DB),
			"--pairs-jsonl",
			[LONDON_PAIRS_JSONL, NI_PAIRS_JSONL, GB_REGIONS_JSONL].join(","),
		],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !(await pathExists(PAIR_INDEX_BIN_DEST))) {
		console.error(`ERROR: failed to build ${PAIR_INDEX_BIN_DEST} (exit ${result.status})`)

		process.exit(1)
	}

	console.log(`built ${PAIR_INDEX_BIN_DEST}`)
}

/**
 * Per-locale FST gazetteer (FST-distribution arc, 2026-07-25): symlink the shared build artifact
 * ($MAILWOMAN_DATA_ROOT/wof/fst-per-locale/) into the package so `resolveWeights` surfaces `fstPath` in dev and the
 * runtime pipeline can auto-wire the gazetteer + street-context gate. The publish flow stages the real binary
 * (release-sequenced).
 */
const FST_SRC = dataRootPath("wof", "fst-per-locale", "fst-en-gb.bin")
/**
 * Where the locale FST is written — a soft-feed sibling, absent in a lean install.
 */
const FST_DEST = resolve(DEST_DIR, "fst-en-gb.bin")

if (await pathExists(FST_SRC)) {
	linkForce(FST_SRC, FST_DEST)

	console.log(`linked fst-en-gb.bin ← ${FST_SRC}`)

	await warnIfFSTStale(FST_SRC, "en-gb")
} else {
	console.error(`WARNING: missing ${FST_SRC} — the FST gazetteer default will resolve OFF for this locale.`)
}

/**
 * Street-morphology FST (static-index candidate 1, 2026-07-26): symlink the sealed locale-general artifact
 * ($MAILWOMAN_DATA_ROOT/wof/fst-street-morphology.bin, `mailwoman gazetteer build street-morphology`) so
 * `resolveWeights` surfaces `streetMorphologyPath` in dev and the street-context gate (#1315) deserializes the artifact
 * instead of rebuilding from dictionaries. Missing is non-fatal — the runtime loader's dictionary-build fallback covers
 * it.
 */
const MORPHOLOGY_SRC = dataRootPath("wof", "fst-street-morphology.bin")
/**
 * Where the street-morphology FST is written — a soft-feed sibling, absent in a lean install.
 */
const MORPHOLOGY_DEST = resolve(DEST_DIR, "fst-street-morphology.bin")

if (await pathExists(MORPHOLOGY_SRC)) {
	linkForce(MORPHOLOGY_SRC, MORPHOLOGY_DEST)

	console.log(`linked fst-street-morphology.bin ← ${MORPHOLOGY_SRC}`)
} else {
	console.error(
		`WARNING: missing ${MORPHOLOGY_SRC} — the street-context gate falls back to the per-process dictionary build.`
	)
}
