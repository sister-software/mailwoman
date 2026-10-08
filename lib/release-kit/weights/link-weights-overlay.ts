/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Populate `$MAILWOMAN_DATA_ROOT/weights/<locale>/` from `release.config.json` — the writer half of the
 *   overlay rung in `@mailwoman/neural`'s `resolveWeights`.
 *
 *   The overlay writes to the data root rather than the tracked package. A worktree starts empty. `yarn test`
 *   could mutate tracked directories. `fs.copyFile` can also write through a leftover symlink that a publish tarball
 *   rejects (`YN0035`). A path outside git avoids these cases. Symlinks are safe there because no operation tars the data root.
 *
 *   Run with `--plan` (or `--dry-run`) to see what it would do and make no change.
 *
 *   ```
 *   yarn mwops release link-weights-overlay --plan
 *   yarn mwops release link-weights-overlay
 *   ```
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { copyFileTo, makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { tryParsingJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { linkForce } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"
import { relative, resolvePath, resolvePathBuilder } from "path-ts"

import { $public } from "#release-kit/env"
import { type BuildableArtifact, type LinkableArtifact, readWeightsRecipe } from "#release-kit/weights/weights-recipe"

export interface LinkWeightsOverlayOptions {
	repoRoot: string
	/**
	 * Report what would be linked and make no change.
	 */
	plan: boolean
	/**
	 * One locale instead of every release locale.
	 */
	locale?: string
	log: (line: string) => void
}

export interface LinkWeightsOverlayReport {
	plan: boolean
	locales: string[]
	linked: number
	missing: number
	mismatched: number
	unrecorded: number
}

/**
 * The digest a weights package records for an artifact it ships, or `undefined`
 * when the package records none.
 *
 * Read from the package's committed `model-card.json`, the same register the release re-verifies
 * against the published tarball, so linking against it checks the release's own claim.
 */
async function recordedDigests(locale: string): Promise<Record<string, string>> {
	const card = resolvePath(workspacePath(`neural-weights-${locale}`), "model-card.json")

	if (!(await pathExists(card))) return {}

	return tryParsingJSON<{ files_md5?: Record<string, string> }>(await readLocalTextFile(card))?.files_md5 ?? {}
}

/**
 * Link every release locale's artifacts into the data-root overlay.
 *
 * @throws On a digest mismatch.
 */
export async function linkWeightsOverlay(options: LinkWeightsOverlayOptions): Promise<LinkWeightsOverlayReport> {
	const { repoRoot, plan, log } = options
	const dataRoot = dataRootPath()

	const recipe = await readWeightsRecipe(resolvePathBuilder(repoRoot), dataRoot, {
		...($public.MAILWOMAN_DEV_MODEL ? { model: $public.MAILWOMAN_DEV_MODEL } : {}),
		...($public.MAILWOMAN_DEV_TOKENIZER ? { tokenizer: $public.MAILWOMAN_DEV_TOKENIZER } : {}),
	})

	const overlayRoot = resolvePath(dataRoot, "weights")
	const locales = options.locale ? [options.locale.toLowerCase()] : recipe.locales

	let linked = 0
	let missing = 0
	let mismatched = 0
	let unrecorded = 0

	for (const locale of locales) {
		const dir = resolvePath(overlayRoot, locale)
		const digests = await recordedDigests(locale)

		if (!plan) {
			await makeDirectories(dir)
		}

		log(`\n${locale}  →  ${relative(dataRoot, dir)}`)

		// The model card is the one artifact from the checkout rather than the data root.
		// without it the loader falls back to STAGE2_BIO_LABELS (21) against a 33-logit model
		// and the first parse throws, so its absence is a broken install rather than a lean one.
		const cardSource = resolvePath(workspacePath(`neural-weights-${locale}`), "model-card.json")

		// Copy the card to keep the overlay independent of one working tree.
		// A worktree removal after linking would leave the card dangling.
		if ((await pathExists(cardSource)) && !plan) {
			await makeDirectories(dir)
			await removePathIfPresent(resolvePath(dir, "model-card.json"))
			await copyFileTo(cardSource, resolvePath(dir, "model-card.json"))
		}

		const artifacts: LinkableArtifact[] = recipe.linkableFor(locale)

		for (const { shippedName, sourcePath } of artifacts) {
			if (!(await pathExists(sourcePath))) {
				missing++
				log(`  ✗ ${shippedName}  source missing: ${sourcePath}`)

				continue
			}

			const recorded = digests[shippedName]

			if (recorded) {
				const actual = await md5File(resolvePath(sourcePath))

				if (actual !== recorded) {
					mismatched++
					log(`  ✗ ${shippedName}  digest MISMATCH: card ${recorded}, source ${actual}`)

					continue
				}
			} else {
				unrecorded++
			}

			if (!plan) {
				await linkForce(sourcePath, resolvePath(dir, shippedName))
			}

			linked++

			log(`  ${plan ? "·" : "✓"} ${shippedName}${recorded ? "  digest ok" : "  (no recorded digest)"}`)
		}

		// Report these artifacts.
		// The per-locale `link-dev-weights.ts` scripts build them into the overlay.
		// Each channel degrades to `undefined` at resolve time, so absence is only visible if it is said here.
		const buildable: BuildableArtifact[] = recipe.buildableFor(locale)

		for (const { shippedName, buildCommand, inputPath } of buildable) {
			const present = await pathExists(resolvePath(dir, shippedName))

			log(
				present
					? `  ✓ ${shippedName}  already built`
					: `  — ${shippedName}  NOT built (${buildCommand}` +
							`${inputPath ? `; input ${(await pathExists(inputPath)) ? "present" : "MISSING"}` : ""})`
			)
		}
	}

	log(
		`\n${plan ? "PLAN" : "LINKED"}: ${linked} artifact(s)` +
			`${missing ? `, ${missing} source(s) missing` : ""}` +
			`${mismatched ? `, ${mismatched} digest mismatch(es)` : ""}` +
			`${unrecorded ? `, ${unrecorded} with no recorded digest` : ""}`
	)

	if (mismatched) {
		throw new Error(
			`link-weights-overlay: ${mismatched} artifact(s) differ from the digest their model card records — the recipe and the card disagree about which model this is.`
		)
	}

	return { plan, locales, linked, missing, mismatched, unrecorded }
}
