/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   codex → corpus-python bridge: emit the authoritative country surface forms as JSON so the Python
 *   shard generators can synthesize address tails ("…, USA" / "…, United States of America") without
 *   re-deriving the country name/alias data. `@mailwoman/codex` stays the single source of truth
 *   (COUNTRY_SURFACE_FORMS + ISO2_TO_NAME, salvaged from isp-nexus spatial/countries); this writes a
 *   snapshot the language boundary can't import directly.
 *
 *   Regenerate: `node codex/tools/export-country-surfaces.ts` (writes the corpus-python data file).
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { COUNTRY_SURFACE_FORMS, ISO2_TO_NAME } from "../country/country.ts"

// Merge: rich surface forms where the codex curates them, else the canonical English name for every
// ISO 3166-1 alpha-2. Canonical-name-first (the codex's own ordering) so the common form leads.
const surfaces: Record<string, string[]> = {}

for (const [iso2, forms] of Object.entries(COUNTRY_SURFACE_FORMS)) {
	surfaces[iso2] = [...forms]
}

for (const [iso2, name] of ISO2_TO_NAME) {
	if (!surfaces[iso2]) surfaces[iso2] = [name]
}

const out = resolve(import.meta.dirname, "../../corpus-python/src/mailwoman_train/data/country-surfaces.json")
writeFileSync(
	out,
	JSON.stringify(
		{
			_generated: "codex/tools/export-country-surfaces.ts from @mailwoman/codex COUNTRY_SURFACE_FORMS + ISO2_TO_NAME",
			surfaces,
		},
		null,
		2
	) + "\n"
)
process.stderr.write(`wrote ${Object.keys(surfaces).length} countries → ${out}\n`)
