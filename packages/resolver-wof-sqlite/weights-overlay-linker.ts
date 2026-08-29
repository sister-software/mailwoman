/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * Shared development tooling for weights overlays: the symlink primitives every overlay linker uses, and the
 * placetype-pair index build.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { dataRootPath, md5File, weightsOverlayPath, workspacePath } from "@mailwoman/core/utils"
import { spawnSync } from "@mailwoman/platform/child_process"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "@mailwoman/platform/fs"
import { resolve } from "@mailwoman/platform/path"

import { fstFreshnessWarning } from "./fst-freshness.ts"

/**
 * Replicate `ln -sf SRC DEST` ATOMICALLY: symlink under a temp name, then rename over the destination. A plain
 * unlink-then-symlink leaves a no-file window that concurrent vitest workers can hit mid-suite — bit CI on 2026-07-24.
 * rename(2) replaces the destination atomically.
 */
export function linkForce(src: string, dest: string): void {
	const tmp = `${dest}.tmp-link`

	if (existsSync(tmp)) {
		unlinkSync(tmp)
	}

	symlinkSync(src, tmp)
	renameSync(tmp, dest)
}

/**
 * Remove a leftover local file/symlink so the #1179 base-weights fallback engages.
 */
export function removeIfPresent(dest: string): void {
	try {
		lstatSync(dest)
	} catch {
		return
	}

	unlinkSync(dest)

	console.log(`removed stale local ${dest} (base fallback to en-us engages)`)
}

/**
 * Symlink one soft-feed sibling into an overlay, warning rather than failing when the source is absent.
 *
 * Every one of these artifacts is OPTIONAL by design — the runtime has a fallback for each, so a fresh worktree that
 * has not built the gazetteer still geocodes. That is why the miss prints the consequence instead of throwing: the
 * operator needs to know which channel just resolved OFF, not to have the link step abort.
 */
export function linkSoftFeedSibling(source: string, destination: string, consequenceIfMissing: string): boolean {
	if (!existsSync(source)) {
		console.error(`WARNING: missing ${source} — ${consequenceIfMissing}`)

		return false
	}

	linkForce(source, destination)

	console.log(`linked ${destination} \u2190 ${source}`)

	return true
}

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
	const sourceStats = statSync(path)

	if (existsSync(sidecarPath)) {
		try {
			if (statSync(sidecarPath).mtime >= sourceStats.mtime) {
				const [hash] = readFileSync(sidecarPath, "utf8").trim().split(/\s+/)

				if (hash && hash.length === MD5_HEX_LENGTH) return hash
			}
		} catch {
			// Unreadable sidecar — recompute below.
		}
	}

	const hash = await md5File(path)
	const filename = path.split(/[/\\]/).pop() || path

	writeFileSync(sidecarPath, `${hash}  ${filename}\n`)

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
export function warnIfFSTStale(fstPath: string, locale: string): void {
	const warning = fstFreshnessWarning({
		fstPath,
		sourceDBPath: String(dataRootPath("wof", "admin-global-priority.db")),
		rebuildCommand: `node packages/mailwoman/out/cli.js gazetteer build fst --locales ${locale}  (writes to a staging dir; swap is operator-gated)`,
	})

	if (warning) {
		console.error(warning)
	}
}

/**
 * Build `pair-index-<country>.bin` into the overlay, skipping the work when the artifact on disk was already built at
 * these magnitudes FROM the admin database on disk.
 *
 * The skip requires both halves (#1734): the header magnitudes (`pairIndexStaleReason`) AND the header's `sourceMD5s`
 * against the current admin DB's md5. Magnitudes alone read a source change as "current" whenever pair counts happen
 * not to move the calibrated numbers — the R5 freshness-guard lesson, which resurfaced in the 2026-08-18 admin swap
 * when all four overlay locales skipped while the md5-checking base linkers rebuilt. This build's ONE source is the
 * admin DB it passes as `--borough-db`, so the comparison is exactly one md5; a linker with a different source list
 * (fr's BAN directory) owns its own guard and must never be pointed at this one.
 *
 * Exits non-zero on a failed build. Missing INPUTS (an unbuilt CLI, an absent WOF database) warn and return instead: a
 * fresh clone has neither, and `yarn test` invokes this to verify auto-resolve, so a hard failure there would be a
 * failure to have run a build yet rather than a real fault.
 */
export async function buildPairIndexOverlay({
	packageDir,
	country,
	delta,
	transitionBeta,
}: PairIndexOverlay): Promise<void> {
	const CLI = String(workspacePath("mailwoman", "out", "cli.js"))
	const ARTIFACT = `pair-index-${country}.bin`
	// Built into the data-root OVERLAY, not into the tracked package. The locale is recovered from the
	// workspace name (`neural-weights-en-gb` → `en-gb`) so callers keep passing the one identifier they
	// already had; the alternative was a second parameter every caller would have to keep in step with the
	// first, which is the drift this whole rollout is removing.
	const PKG_DIR = String(weightsOverlayPath(packageDir.replace(/^neural-weights-/, "")))
	const DEST = resolve(PKG_DIR, ARTIFACT)

	mkdirSync(PKG_DIR, { recursive: true })
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
			const header = peekPairIndexHeaderFields(DEST)
			const reason = pairIndexStaleReason(header, { delta, transitionBeta })

			if (reason) {
				console.log(`rebuilding ${ARTIFACT} — ${reason}`)
			} else {
				// The source-md5 half (#1734). This build reads exactly one source, so one md5; an artifact that
				// recorded none, or a different count, predates the stamp and is stale by that fact alone.
				const adminMD5 = await md5FileWithSidecar(WOF_ADMIN_DB)

				if (header.sourceMD5s.length === 1 && header.sourceMD5s[0] === adminMD5) {
					console.log(`skipped ${ARTIFACT} build — ${DEST} is current (magnitudes + source md5 match)`)

					return
				}

				console.log(
					`rebuilding ${ARTIFACT} — header source md5s [${header.sourceMD5s.join(", ") || "(none recorded)"}] != ` +
						`current admin DB [${adminMD5}]`
				)
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
