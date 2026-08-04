/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The dev-weights build every PAIR-INDEX-ONLY weights overlay runs, in one place.
 *
 *   WHY THIS EXISTS. An overlay that declares `mailwoman.baseWeights` ships exactly one artifact and
 *   symlinks nothing, so its `scripts/link-dev-weights.ts` was ~117 lines of identical machinery
 *   differing only in a two-letter country code. `scaffold-weights-overlay.ts` used to end by telling
 *   the author to "copy the closest sibling's build block", and that instruction did what copy
 *   instructions do: `es-es` and `it-it` both shipped `de-de`'s docstring, telling the reader the
 *   index is inert without the `de` entries because "German addresses write 50733 Köln". The code was
 *   correct in both. Everything a reader would use to CHECK the code named the wrong country, and
 *   nothing catches that, because the script works.
 *
 *   So the machinery lives here and an overlay supplies a manifest. There is no build block left to
 *   copy, and the prose that remains in each overlay is the part that is genuinely per-locale.
 *
 *   NOT for the base packages. `en-us`, `en-gb`, `en-nz` and `fr-fr` symlink a model and tokenizer,
 *   verify md5s against their model card, and build several artifacts apiece; they legitimately
 *   differ and stay hand-written. This covers the overlay shape only, and refuses anything else by
 *   construction — it takes a country code and builds one pair index.
 *
 *   Callers are dev-only and excluded from the published tarball (`!scripts/**`), which is what lets
 *   an overlay script import this file by relative path.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

/**
 * What one pair-index overlay has to say about itself. Everything else is shared.
 */
export interface PairIndexOverlay {
	/**
	 * Workspace directory name, e.g. `neural-weights-de-de`.
	 */
	packageDir: string
	/**
	 * ISO country code passed to `gazetteer pair-index --country`, and the suffix of the built artifact (`de` →
	 * `pair-index-de.bin`). NOT the locale tag: `en-in` builds `pair-index-in.bin`.
	 */
	country: string
	/**
	 * Calibrated magnitudes the locale's bars were measured at. Baked into the artifact's PIX1 header, which is how the
	 * freshness check below notices a change to either.
	 */
	delta: number
	transitionBeta: number
}

/**
 * The header fields a dev-weights freshness guard reads.
 */
export interface PairIndexHeaderFields {
	delta: number
	transitionBeta: number | undefined
	parentDelta: number | undefined
	schemaVersion: number
	/**
	 * One md5 per source the build read, in fold order. Empty on a header that recorded none.
	 */
	sourceMD5s: string[]
}

/**
 * Minimal PIX1 header reader — magic + header only, reimplemented so a data-only weights package gains no dependency on
 * `@mailwoman/neural` (which pulls onnxruntime-node) to read a few fields. `neural/pair-index-resolver.ts`'s own header
 * parse is the source of truth this must follow.
 *
 * Shared by the overlay build below AND by the four hand-written base linkers
 * (`neural-weights-{en-us,en-gb,en-nz,fr-fr}/scripts/link-dev-weights.ts`), which each carried their own near-copy
 * before 2026-08-04 — the ×5 clone the taste audit named, and the reason three of them were schema-blind while this one
 * was not.
 */
export function peekPairIndexHeaderFields(path: string): PairIndexHeaderFields {
	const bytes = readFileSync(path)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	// "PIX1" little-endian.
	const MAGIC = 0x31_58_49_50

	if (view.getUint32(0, true) !== MAGIC) {
		throw new Error(`pair index: bad magic reading ${path}`)
	}

	const headerLen = view.getUint32(4, true)

	const header = parseJSONStrict<{
		delta: number
		transitionBeta?: number
		parentDelta?: number
		schemaVersion: number
		sourceMD5s?: string[]
	}>(Buffer.from(bytes.subarray(8, 8 + headerLen)).toString("utf8"))

	return {
		delta: header.delta,
		transitionBeta: header.transitionBeta,
		parentDelta: header.parentDelta,
		schemaVersion: header.schemaVersion,
		sourceMD5s: header.sourceMD5s ?? [],
	}
}

/**
 * The calibrated magnitudes a linker bakes into its artifact. `undefined` means the flag is NOT passed and the header
 * carries no such key — a real state, distinct from zero (see `PairIndexHeader.parentDelta`), so the comparison below
 * is `!==` against `undefined` rather than a truthiness test.
 */
export interface PairIndexCalibration {
	delta: number
	transitionBeta?: number
	parentDelta?: number
}

/**
 * Why an existing `pair-index-*.bin` is stale against `expected`, or `undefined` when its header matches. Covers the
 * FORMAT (schemaVersion) and every calibrated magnitude; source-md5 freshness stays with the caller, because each base
 * linker passes a different set of sources and only it knows what they are.
 *
 * One place so a magnitude added to the header cannot be checked by some linkers and not others — which is exactly how
 * three of the four base linkers ended up unable to notice a schema bump.
 */
export function pairIndexStaleReason(
	header: PairIndexHeaderFields,
	expected: PairIndexCalibration
): string | undefined {
	if (header.schemaVersion !== REQUIRED_PAIR_INDEX_SCHEMA) {
		return `schemaVersion ${header.schemaVersion} → ${REQUIRED_PAIR_INDEX_SCHEMA}`
	}

	if (header.delta !== expected.delta) return `delta ${header.delta} → ${expected.delta}`

	if (header.transitionBeta !== expected.transitionBeta) {
		return `transitionBeta ${header.transitionBeta ?? "(absent)"} → ${expected.transitionBeta ?? "(absent)"}`
	}

	if (header.parentDelta !== expected.parentDelta) {
		return `parentDelta ${header.parentDelta ?? "(absent)"} → ${expected.parentDelta ?? "(absent)"}`
	}

	return undefined
}

/**
 * The PIX1 schema this tree's reader requires. MUST equal `KNOWN_SCHEMA_VERSION` in `neural/pair-index-resolver.ts` —
 * they are two ends of one fact, and this copy exists only because a data-only overlay must not gain a dependency on
 * `@mailwoman/neural` (onnxruntime-node) to read one header field. Bump BOTH in the same commit; a schema bump that
 * leaves this behind makes every dev checkout rebuild-loop or serve an artifact the runtime refuses.
 *
 * The freshness guard must compare it: a guard that checks only delta + source md5 reads a format-obsolete binary as
 * "current" and leaves every dev checkout with artifacts the runtime refuses — the R5 freshness-guard lesson, format
 * edition. Also compared by the four hand-written base linkers (`neural-weights-{en-us,en-gb,en-nz,fr-fr}`), which
 * import this constant rather than re-typing the number.
 */
export const REQUIRED_PAIR_INDEX_SCHEMA = 3

/**
 * Build `pair-index-<country>.bin` into the overlay, skipping the work when the artifact on disk was already built at
 * these magnitudes.
 *
 * Exits non-zero on a failed build. Missing INPUTS (an unbuilt CLI, an absent WOF database) warn and return instead: a
 * fresh clone has neither, and `yarn test` invokes this to verify auto-resolve, so a hard failure there would be a
 * failure to have run a build yet rather than a real fault.
 */
export function buildPairIndexOverlay({ packageDir, country, delta, transitionBeta }: PairIndexOverlay): void {
	const PKG_DIR = String(repoRootPath(packageDir))
	const CLI = String(repoRootPath("mailwoman", "out", "cli.js"))
	const ARTIFACT = `pair-index-${country}.bin`
	const DEST = resolve(PKG_DIR, ARTIFACT)
	/**
	 * Checked-in WOF-derived admin pairs — the same posture as the GB secondary sources.
	 */
	const WOF_ADMIN_DB = String(dataRootPath("wof", "admin-global-priority.db"))

	if (!existsSync(CLI)) {
		console.error(`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run for ${ARTIFACT}.`)

		return
	}

	if (!existsSync(WOF_ADMIN_DB)) {
		console.error(`WARNING: missing ${WOF_ADMIN_DB} — ${ARTIFACT} not built.`)

		return
	}

	if (existsSync(DEST)) {
		try {
			// No `parentDelta` in the expectation: the overlay locales (de/in/es/it) ship WITHOUT the whole-edge
			// parent bias — unmeasured there, and the D-rule's answer to an unmeasured locale is a per-locale
			// gate, not an inherited magnitude. `PairIndexOverlay` therefore has no `parentDelta` field to pass;
			// adding one is a deliberate act that should arrive with a board.
			const reason = pairIndexStaleReason(peekPairIndexHeaderFields(DEST), { delta, transitionBeta })

			if (reason) {
				console.log(`rebuilding ${ARTIFACT} — ${reason}`)
			} else {
				console.log(`skipped ${ARTIFACT} build — ${DEST} is current`)

				return
			}
		} catch (error) {
			console.log(`rebuilding ${ARTIFACT} — header unreadable (${(error as Error).message})`)
		}
	}

	const result = spawnSync(
		process.execPath,
		[
			CLI,
			"gazetteer",
			"pair-index",
			"--out",
			PKG_DIR,
			"--country",
			country,
			"--delta",
			String(delta),
			"--transition-beta",
			String(transitionBeta),
			"--borough-db",
			WOF_ADMIN_DB,
		],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !existsSync(DEST)) {
		console.error(`FAILED: gazetteer pair-index --country ${country} (exit ${result.status})`)

		process.exit(1)
	}

	console.log(`built ${ARTIFACT} ← ${WOF_ADMIN_DB}`)
}
