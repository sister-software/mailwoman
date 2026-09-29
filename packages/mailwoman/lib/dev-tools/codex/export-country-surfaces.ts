/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Exports country names and aliases as JSON for the Python extract generators.
 *   `@mailwoman/codex` remains the source of truth. This writes a snapshot for Python.
 *
 *   Regenerate with: `node packages/mailwoman/lib/dev-tools/codex/export-country-surfaces.ts`
 */

import { COUNTRY_SURFACE_FORMS, ISO2_TO_NAME } from "@mailwoman/codex/country"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"

// Use curated forms when available, otherwise use the canonical English name.
// Keep the codex's order so the common form comes first.
const surfaces: Record<string, string[]> = {}

for (const [iso2, forms] of Object.entries(COUNTRY_SURFACE_FORMS)) {
	surfaces[iso2] = [...forms]
}

for (const [iso2, name] of ISO2_TO_NAME) {
	if (!surfaces[iso2]) {
		surfaces[iso2] = [name]
	}
}

const out = repoRootPath("corpus-python", "src", "mailwoman_train", "data", "country-surfaces.json")

await writeLocalTextFile(
	prettyJSON({
		_generated:
			"packages/mailwoman/lib/dev-tools/codex/export-country-surfaces.ts from @mailwoman/codex COUNTRY_SURFACE_FORMS + ISO2_TO_NAME",
		surfaces,
	}),
	out
)

process.stderr.write(`wrote ${Object.keys(surfaces).length} countries → ${out}\n`)
