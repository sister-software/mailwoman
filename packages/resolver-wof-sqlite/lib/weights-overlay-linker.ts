/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * Shared development tooling for weights overlays: the symlink primitives every overlay linker uses, and the
 * placetype-pair index build.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalTextFile, statPath, readLocalBuffer, statLink } from "@mailwoman/core/fs/readers"
import {
	createSymbolicLink,
	makeDirectories,
	movePath,
	removePath,
	writeLocalTextFile,
} from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { workspacePath } from "@mailwoman/core/paths"
import { spawnProcessSync } from "@mailwoman/core/process"
import { md5File, weightsOverlayPath } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"

import { fstFreshnessWarning } from "#fst/freshness"

/**
 * Replicate `ln -sf SRC DEST` ATOMICALLY: symlink under a temp name, then rename over the destination. A plain
 * unlink-then-symlink leaves a no-file window that concurrent vitest workers can hit mid-suite — bit CI on 2026-07-24.
 * rename(2) replaces the destination atomically.
 */
export async function linkForce(src: string, dest: string): Promise<void> {
	const tmp = `${dest}.tmp-link`

	if (await pathExists(tmp)) {
		await removePath(tmp)
	}

	await createSymbolicLink(src, tmp)
	await movePath(tmp, dest)
}

/**
 * Remove a leftover local file/symlink so the #1179 base-weights fallback engages.
 */
export async function removeIfPresent(dest: string): Promise<void> {
	try {
		await statLink(dest)
	} catch {
		return
	}

	await removePath(dest)

	console.log(`removed stale local ${dest} (base fallback to en-us engages)`)
}

/**
 * Symlink one soft-feed sibling into an overlay, warning rather than failing when the source is absent.
 *
 * Every one of these artifacts is OPTIONAL by design — the runtime has a fallback for each, so a fresh worktree that
 * has not built the gazetteer still geocodes. That is why the miss prints the consequence instead of throwing: the
 * operator needs to know which channel just resolved OFF, not to have the link step abort.
 */
export async function linkSoftFeedSibling(
	source: string,
	destination: string,
	consequenceIfMissing: string
): Promise<boolean> {
	if (!(await pathExists(source))) {
		console.error(`WARNING: missing ${source} — ${consequenceIfMissing}`)

		return false
	}

	await linkForce(source, destination)

	console.log(`linked ${destination} \u2190 ${source}`)

	return true
}

/**
 * The calibrated pair-index emission bias every shipped artifact is built at today — the R5/R6/R9/R10/R11 bars were all
 * measured at δ=10 (each linker's own docstring carries its locale's receipt).
 */
export const PAIR_INDEX_DELTA = 10

/**
 * The decoder transition-entry bonus (TRANSITION-BETA build, 2026-07-24 — operator-approved β=5 from the
 * transition-level probe). en-nz deliberately builds WITHOUT one (unmeasured there): the two magnitudes are calibrated
 * independently, and a locale earning one says nothing about the other.
 */
export const PAIR_INDEX_TRANSITION_BETA = 5

/**
 * The WHOLE-EDGE parent-bias magnitude (#46, default-on 2026-08-04) at the verdict's recommended δ=5 — see
 * `docs/records/evals/2026-08-04-pix1-whole-edge-verdict.md`. Only the measured locales (us/gb/nz/fr) pass it; the
 * D-rule's answer to an unmeasured locale is a per-locale absence, not an inherited magnitude.
 */
export const PAIR_INDEX_PARENT_DELTA = 5

/**
 * What one pair-index build has to say about itself. Everything else is shared.
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
	 * freshness check notices a change to any of them. An ABSENT `transitionBeta`/`parentDelta` means the flag is not
	 * passed and the header carries no such key — a real state, distinct from zero (see `PairIndexHeader.parentDelta`).
	 * The whole calibration feeds both the build FLAGS and the staleness EXPECTATION, so the two cannot disagree.
	 */
	delta: number
	transitionBeta?: number
	parentDelta?: number
	/**
	 * Source FILES whose md5s the build records, in the order `gazetteer pair-index` records them. The freshness guard
	 * compares EVERY one against the existing header (#1734): a partial comparison leaves the guard blind to the rest,
	 * and a stale artifact then keeps reporting itself fresh while the data it was built from has moved. Empty means the
	 * build's source cannot be file-hashed (fr's BAN directory) and freshness rests on the magnitudes alone. Default: the
	 * WOF admin DB.
	 */
	sources?: string[]
	/**
	 * Inputs that must exist before a build is attempted — a missing one warns and returns, because a fresh clone has no
	 * data root and `yarn test` invokes the linkers to verify auto-resolve. Default: `sources`.
	 */
	inputs?: string[]
	/**
	 * Extra CLI args naming the build's sources (`--source`, `--borough-db`, `--pairs-jsonl`, `--ban-dir`). Default:
	 * `--borough-db <admin db>`.
	 */
	extraArgs?: string[]
	/**
	 * Refuse to trust an existing artifact smaller than this. fr-fr's guard: a pair index built from the WRONG source can
	 * carry matching magnitudes, and size is the one signal the header cannot fake.
	 */
	minimumPlausibleBytes?: number
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
export async function peekPairIndexHeaderFields(path: string): Promise<PairIndexHeaderFields> {
	const bytes = await readLocalBuffer(path)
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
 * Hex characters in an md5 digest.
 */
const MD5_HEX_LENGTH = 32

/**
 * Md5 of `path`, cached in a standard `md5sum`-format sidecar (`<hash> <filename>`) beside it so a multi-gigabyte
 * source is hashed once per change rather than once per linker run. The sidecar is trusted only when at least as new as
 * the source; a missing or stale sidecar recomputes and rewrites, so the cache self-heals.
 *
 * The shared home for the copies the base linkers (`en-us`, `en-gb`, `en-nz`) each carry — new callers import this one.
 */
export async function md5FileWithSidecar(path: string): Promise<string> {
	const sidecarPath = `${path}.md5`
	const sourceStats = await statPath(path)

	if (await pathExists(sidecarPath)) {
		try {
			if ((await statPath(sidecarPath)).mtime >= sourceStats.mtime) {
				const [hash] = (await readLocalTextFile(sidecarPath)).trim().split(/\s+/)

				if (hash && hash.length === MD5_HEX_LENGTH) return hash
			}
		} catch {
			// Unreadable sidecar — recompute below.
		}
	}

	const hash = await md5File(path)
	const filename = path.split(/[/\\]/).pop() || path

	await writeLocalTextFile(`${hash}  ${filename}\n`, sidecarPath)

	return hash
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
 * Warn when the per-locale FST a linker just symlinked was built from a DIFFERENT admin database than the one on disk
 * now.
 *
 * WHY IT WARNS RATHER THAN REBUILDS, unlike its pair-index sibling above. A pair index is seconds of work and the
 * linker owns its whole recipe. A locale FST is a multi-minute build whose output goes to a STAGING dir on purpose —
 * the swap into `fst-per-locale/` is operator-gated after the battery, because an FST changes decoder behaviour and the
 * D-rule does not let that land unmeasured. So the guard's job is to make the drift impossible to miss, and to name the
 * command that starts fixing it. It is also why a stale FST is never fatal: the artifact is a decode-time bias list,
 * and a dev tree must still run.
 *
 * The source-side half of the comparison lives here rather than in `fst-freshness.ts` for the same reason
 * `pairIndexStaleReason` splits: only the caller knows which database it built against. All three FST-linking base
 * packages build against the same one, so they share this rather than each pinning it.
 */
export async function warnIfFSTStale(fstPath: string, locale: string): Promise<void> {
	const warning = await fstFreshnessWarning({
		fstPath,
		sourceDBPath: String(dataRootPath("wof", "admin-global-priority.db")),
		rebuildCommand: `node packages/mailwoman/out/cli.js gazetteer build fst --locales ${locale}  (writes to a staging dir; swap is operator-gated)`,
	})

	if (warning) {
		console.error(warning)
	}
}

/**
 * Symlink the per-locale FST gazetteer (`fst-<locale>.bin`) from the shared build area
 * (`$MAILWOMAN_DATA_ROOT/wof/fst-per-locale/`) into an overlay so `resolveWeights` surfaces `fstPath` in dev and the
 * runtime pipeline can auto-wire the gazetteer + street-context gate, then run {@link warnIfFSTStale} on the linked
 * artifact. The publish flow stages the real binary (release-sequenced).
 */
export async function linkLocaleFST(destDir: string, locale: string): Promise<void> {
	const source = String(dataRootPath("wof", "fst-per-locale", `fst-${locale}.bin`))

	const linked = await linkSoftFeedSibling(
		source,
		resolvePath(destDir, `fst-${locale}.bin`),
		"the FST gazetteer default will resolve OFF for this locale."
	)

	if (linked) {
		await warnIfFSTStale(source, locale)
	}
}

/**
 * Symlink the sealed locale-general street-morphology FST (`$MAILWOMAN_DATA_ROOT/wof/fst-street-morphology.bin`,
 * `mailwoman gazetteer build street-morphology`) into an overlay so `resolveWeights` surfaces `streetMorphologyPath` in
 * dev and the street-context gate (#1315) deserializes the artifact instead of rebuilding from the libpostal
 * dictionaries per process. Missing is non-fatal — the runtime loader's dictionary-build fallback covers it.
 */
export async function linkStreetMorphologyFST(destDir: string): Promise<void> {
	await linkSoftFeedSibling(
		String(dataRootPath("wof", "fst-street-morphology.bin")),
		resolvePath(destDir, "fst-street-morphology.bin"),
		"the street-context gate falls back to the per-process dictionary build."
	)
}

/**
 * Why an existing artifact may be TRUSTED without a rebuild, or `undefined` when it must be rebuilt (with the reason
 * already printed). The skip requires both halves (#1734): the header magnitudes + format (`pairIndexStaleReason`) AND
 * the header's `sourceMD5s` against the current sources' md5s. Magnitudes alone read a source change as "current"
 * whenever pair counts happen not to move the calibrated numbers — the R5 freshness-guard lesson, which resurfaced in
 * the 2026-08-18 admin swap. A source that is not on disk to re-hash leaves the magnitudes as the best available answer
 * (the "missing source, can't build" branch below would fire anyway if a rebuild were needed).
 */
async function pairIndexIsFresh(
	dest: string,
	artifact: string,
	expected: PairIndexCalibration,
	sources: string[],
	minimumPlausibleBytes: number | undefined
): Promise<boolean> {
	try {
		const header = await peekPairIndexHeaderFields(dest)
		const staleReason = pairIndexStaleReason(header, expected)

		if (staleReason) {
			console.log(`rebuilding ${artifact} — ${staleReason}`)

			return false
		}

		if (minimumPlausibleBytes !== undefined && (await statPath(dest)).size < minimumPlausibleBytes) {
			console.log(
				`rebuilding ${artifact} — ${(await statPath(dest)).size.toLocaleString()} bytes is implausibly small ` +
					`for this recipe (wrong-source clobber)`
			)

			return false
		}

		if (!sources.length) {
			console.log(`skipped ${artifact} build — ${dest} is current (magnitudes match; no file-hashable source)`)

			return true
		}

		for (const source of sources) {
			if (!(await pathExists(source))) {
				console.log(
					`skipped ${artifact} build — ${dest} has matching header magnitudes (${source} absent, md5 freshness unverifiable)`
				)

				return true
			}
		}

		if (header.sourceMD5s.length !== sources.length) {
			console.log(
				`rebuilding ${artifact} — header records ${header.sourceMD5s.length} source md5s ` +
					`[${header.sourceMD5s.join(", ") || "(none recorded)"}], but this build reads ${sources.length}`
			)

			return false
		}

		const currentMD5s: string[] = []

		for (const source of sources) {
			currentMD5s.push(await md5FileWithSidecar(source))
		}

		if (currentMD5s.every((md5, i) => md5 === header.sourceMD5s[i])) {
			console.log(
				`skipped ${artifact} build — ${dest} is current (magnitudes + all ${sources.length} source md5s match)`
			)

			return true
		}

		console.log(
			`rebuilding ${artifact} — header source md5s [${header.sourceMD5s.join(", ")}] != current [${currentMD5s.join(", ")}]`
		)

		return false
	} catch (error) {
		console.log(`rebuilding ${artifact} — freshness unverifiable (${(error as Error).message})`)

		return false
	}
}

/**
 * Build `pair-index-<country>.bin` into the overlay, skipping the work when the artifact on disk was already built at
 * these magnitudes FROM the sources on disk (see {@link pairIndexIsFresh}). The calibration object drives both the
 * staleness expectation and the CLI flags, so a magnitude cannot be checked by the guard and dropped from the build.
 *
 * Exits non-zero on a failed build. Missing INPUTS (an unbuilt CLI, an absent source) warn and return instead: a fresh
 * clone has neither, and `yarn test` invokes this to verify auto-resolve, so a hard failure there would be a failure to
 * have run a build yet rather than a real fault.
 */
export async function buildPairIndexOverlay(overlay: PairIndexOverlay): Promise<void> {
	const { packageDir, country, delta, transitionBeta, parentDelta } = overlay
	const CLI = String(workspacePath("mailwoman", "out", "cli.js"))
	const ARTIFACT = `pair-index-${country}.bin`
	// Built into the data-root OVERLAY, not into the tracked package. The locale is recovered from the
	// workspace name (`neural-weights-en-gb` → `en-gb`) so callers keep passing the one identifier they
	// already had.
	const PKG_DIR = String(weightsOverlayPath(packageDir.replace(/^neural-weights-/, "")))
	const DEST = resolvePath(PKG_DIR, ARTIFACT)

	await makeDirectories(PKG_DIR)

	/**
	 * Checked-in WOF-derived admin pairs — the default source, and the whole source list for the small overlays.
	 */
	const WOF_ADMIN_DB = String(dataRootPath("wof", "admin-global-priority.db"))
	const sources = overlay.sources ?? [WOF_ADMIN_DB]
	const inputs = overlay.inputs ?? sources
	const extraArgs = overlay.extraArgs ?? ["--borough-db", WOF_ADMIN_DB]

	if (!(await pathExists(CLI))) {
		console.error(`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run for ${ARTIFACT}.`)

		return
	}

	if (
		(await pathExists(DEST)) &&
		(await pairIndexIsFresh(
			DEST,
			ARTIFACT,
			{ delta, transitionBeta, parentDelta },
			sources,
			overlay.minimumPlausibleBytes
		))
	) {
		return
	}

	for (const input of inputs) {
		if (await pathExists(input)) continue

		console.error(
			`WARNING: missing ${input} — ${ARTIFACT} not built; the placetype-pair prior stays inert for ${country.toUpperCase()}.`
		)

		return
	}

	const result = spawnProcessSync(
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
			...(transitionBeta === undefined ? [] : ["--transition-beta", String(transitionBeta)]),
			...(parentDelta === undefined ? [] : ["--parent-delta", String(parentDelta)]),
			...extraArgs,
		],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !(await pathExists(DEST))) {
		console.error(`FAILED: gazetteer pair-index --country ${country} (exit ${result.status})`)

		process.exit(1)
	}

	console.log(`built ${ARTIFACT}`)
}
