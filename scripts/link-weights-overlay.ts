/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Populate `$MAILWOMAN_DATA_ROOT/weights/<locale>/` from `release.config.json` — the writer half of the
 *   overlay rung in `@mailwoman/neural`'s `resolveWeights`.
 *
 *   WHY THE DATA ROOT AND NOT THE PACKAGE. The ten `link-dev-weights.ts` scripts materialize the same
 *   artifacts INTO tracked package directories, and that single choice causes four separate hazards: a git
 *   worktree starts empty and cannot geocode, `yarn test` mutates tracked directories as a side effect of
 *   `weights.test.ts`, `fs.copyFile` writes THROUGH a leftover symlink, and a publish tarball is refused for
 *   containing one (`YN0035`). Writing outside git removes the cause of all four. Symlinks are safe here
 *   precisely because nothing tars the data root.
 *
 *   Run with `--plan` to see what it would do and change nothing.
 *
 *   ```
 *   node scripts/link-weights-overlay.ts --plan
 *   node scripts/link-weights-overlay.ts
 *   ```
 */

import { $public } from "@mailwoman/core/env"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { mailwomanDataRoot, md5File, repoRootPath, workspacePath } from "@mailwoman/core/utils"
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from "@mailwoman/platform/fs"
import { relative, resolve } from "@mailwoman/platform/path"
import { parseArgs } from "@mailwoman/platform/util"

import { readWeightsRecipe } from "./weights-recipe.ts"

const { values } = parseArgs({
	options: {
		plan: { type: "boolean", default: false },
		locale: { type: "string" },
	},
})

const repoRoot = String(repoRootPath())
const dataRoot = String(mailwomanDataRoot())

const recipe = readWeightsRecipe(repoRoot, dataRoot, {
	...($public.MAILWOMAN_DEV_MODEL ? { model: $public.MAILWOMAN_DEV_MODEL } : {}),
	...($public.MAILWOMAN_DEV_TOKENIZER ? { tokenizer: $public.MAILWOMAN_DEV_TOKENIZER } : {}),
})

const overlayRoot = resolve(dataRoot, "weights")
const locales = values.locale ? [values.locale.toLowerCase()] : recipe.locales

/**
 * The digest a weights package RECORDS for an artifact it ships, or `undefined` when the package records none.
 *
 * Read from the package's committed `model-card.json`, which is the register the release re-verifies against the
 * published tarball — so linking against it is checking the same claim the release checks, not a second one. Measured
 * across the ten workspaces: only `en-us` populates `files_md5`. Every overlay's is empty, which is defensible for the
 * shared base binaries and is not defensible for the artifacts an overlay actually owns.
 */
function recordedDigests(locale: string): Record<string, string> {
	const card = resolve(String(workspacePath(`neural-weights-${locale}`)), "model-card.json")

	if (!existsSync(card)) return {}

	return tryParsingJSON<{ files_md5?: Record<string, string> }>(readFileSync(card, "utf8"))?.files_md5 ?? {}
}

/**
 * Replace `dest` with a symlink to `source`, removing whatever is there first.
 *
 * `rmSync` before `symlinkSync` rather than after a check: a dangling symlink fails `existsSync` (which follows the
 * link) while still occupying the name, so a check-then-create leaves the stale link in place and reports success.
 */
function linkForce(source: string, dest: string): void {
	try {
		lstatSync(dest)
		rmSync(dest, { force: true })
	} catch {
		// Nothing there. The lstat throw IS the check — `existsSync` would answer the wrong question.
	}

	symlinkSync(source, dest)
}

let linked = 0
let missing = 0
let mismatched = 0
let unrecorded = 0

for (const locale of locales) {
	const dir = resolve(overlayRoot, locale)
	const digests = recordedDigests(locale)

	if (!values.plan) {
		mkdirSync(dir, { recursive: true })
	}

	process.stdout.write(`\n${locale}  →  ${relative(dataRoot, dir)}\n`)

	// The model card is the one artifact that comes from the CHECKOUT rather than the data root: it is committed,
	// and `resolveFromPackageDir` reads it from whichever directory answered. Without it in the overlay the loader
	// falls back to STAGE2_BIO_LABELS (21) against a 33-logit model and the first parse throws in
	// `assertEmissionWidth` — so its absence is not a lean install, it is a broken one. Linking it does couple the
	// overlay to the checkout that wrote it; the writer is idempotent, so re-running from another checkout re-points it.
	const cardSource = resolve(String(workspacePath(`neural-weights-${locale}`)), "model-card.json")

	// COPIED, not linked. Every other overlay entry points at the data root, which outlives any checkout; a
	// symlink to the card would make the whole overlay depend on one working tree still existing at that
	// path — and a worktree removed after linking would leave the overlay resolving a dangling card, which
	// degrades to STAGE2_BIO_LABELS against a 33-logit model rather than to an error.
	if (existsSync(cardSource) && !values.plan) {
		mkdirSync(dir, { recursive: true })
		rmSync(resolve(dir, "model-card.json"), { force: true })
		copyFileSync(cardSource, resolve(dir, "model-card.json"))
	}

	const artifacts = recipe.linkableFor(locale)

	for (const { shippedName, sourcePath } of artifacts) {
		if (!existsSync(sourcePath)) {
			missing++
			process.stdout.write(`  ✗ ${shippedName}  source missing: ${sourcePath}\n`)

			continue
		}

		const recorded = digests[shippedName]

		if (recorded) {
			const actual = await md5File(sourcePath)

			if (actual !== recorded) {
				mismatched++
				process.stdout.write(`  ✗ ${shippedName}  digest MISMATCH: card ${recorded}, source ${actual}\n`)

				continue
			}
		} else {
			unrecorded++
		}

		if (!values.plan) {
			linkForce(sourcePath, resolve(dir, shippedName))
		}

		linked++

		process.stdout.write(
			`  ${values.plan ? "·" : "✓"} ${shippedName}${recorded ? "  digest ok" : "  (no recorded digest)"}\n`
		)
	}

	// Reported, never silently skipped. These are the channels the overlay will LACK, and every one of them
	// degrades to `undefined` at resolve time rather than failing — so absence here is only visible if it is
	// said here.
	// REPORTED, never linked. An earlier version symlinked a build output from the workspace into the
	// overlay, and that inverted the whole point: the per-locale linkers then wrote THROUGH the symlink and
	// their artifacts landed back in the tracked package. It is the `fs.copyFile`-follows-a-symlink hazard
	// AGENTS.md documents for the publish path, reappearing one directory over. The per-locale
	// `link-dev-weights.ts` scripts build these into the overlay directly; this only says whether they have.
	for (const { shippedName, buildCommand, inputPath } of recipe.buildableFor(locale)) {
		const present = existsSync(resolve(dir, shippedName))

		process.stdout.write(
			present
				? `  ✓ ${shippedName}  already built\n`
				: `  — ${shippedName}  NOT built (${buildCommand}` +
						`${inputPath ? `; input ${existsSync(inputPath) ? "present" : "MISSING"}` : ""})\n`
		)
	}
}

process.stdout.write(
	`\n${values.plan ? "PLAN" : "LINKED"}: ${linked} artifact(s)` +
		`${missing ? `, ${missing} source(s) missing` : ""}` +
		`${mismatched ? `, ${mismatched} digest mismatch(es)` : ""}` +
		`${unrecorded ? `, ${unrecorded} with no recorded digest` : ""}\n`
)

// A digest mismatch is the one failure that must stop a caller: it means the recipe and the card disagree about
// which model this is, which is the exact condition the 9.0.0 lockstep miss produced.
if (mismatched) {
	process.exitCode = 1
}
