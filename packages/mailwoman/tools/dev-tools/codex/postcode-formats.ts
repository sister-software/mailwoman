/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate `@mailwoman/codex`'s per-country postcode formats from libaddressinput's `zip` pattern and the
 *   literal its `fmt` prints ahead of `%Z` (`MD-%Z`, `AX-%Z`), so the table is derived rather than transcribed.
 *
 *   Usage: `node packages/mailwoman/tools/dev-tools/codex/postcode-formats.ts`
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { Globerator } from "spliterator/node/fs"

interface AddressMetadata {
	readonly fmt?: string
	readonly zip?: string
}

/**
 * The country-code prefix a `fmt` prints immediately before `%Z`, such as `MD-` in `MD-%Z %C`.
 *
 * Only a two-letter code joined by a hyphen counts.
 * `%C PR %Z` prints a region code with spaces around it, and that region code is not part of the postcode.
 */
function postcodePrefix(fmt: string | undefined): string | null {
	const match = fmt?.match(/(?:^|%n|%[A-Z]|\s)([A-Z]{2}-)%Z/u)

	return match ? match[1]! : null
}

/**
 * The repository formatter's print width, with a tab counted as four columns.
 */
const PRINT_WIDTH = 120

const specsDirectory = resolvePackageDirectory("@mailwoman/core")("data", "chromium-i18n", "ssl-address")
const entries: string[] = []
let withoutPattern = 0

for (const file of await Globerator.files("json", {
	cwd: specsDirectory,
	absolute: false,
	recursive: false,
}).toSorted()) {
	const code = file.replace(/\.json$/, "")
	const metadata = await readLocalJSONFile<AddressMetadata>(specsDirectory(file))

	if (!metadata.zip) {
		withoutPattern++

		continue
	}

	// Refuse a pattern JavaScript cannot compile, rather than emitting a table that throws at module load.
	new RegExp(`^(?:${metadata.zip})$`, "iu")

	const prefix = postcodePrefix(metadata.fmt)
	const pattern = stringifyJSON(metadata.zip)
	const prefixField = prefix ? `prefix: ${stringifyJSON(prefix)}` : null
	const inline = `\t${code}: { ${[`pattern: ${pattern}`, ...(prefixField ? [prefixField] : [])].join(", ")} },`

	// The repository formatter breaks an entry wider than its print width onto one line per field,
	// so the generator writes that form itself and the output needs no formatting pass.
	entries.push(
		inline.replace("\t", "    ").length <= PRINT_WIDTH
			? inline
			: [
					`\t${code}: {`,
					`\t\tpattern:`,
					`\t\t\t${pattern},`,
					...(prefixField ? [`\t\t${prefixField},`] : []),
					`\t},`,
				].join("\n")
	)
}

const emitted = `/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @generated
 *
 *   generated — run \`node packages/mailwoman/tools/dev-tools/codex/postcode-formats.ts\` to refresh. Do not edit by hand.
 *
 *   One postcode format per country that libaddressinput states one for: its \`zip\` pattern, and the country-code
 *   prefix its \`fmt\` prints ahead of the postcode. A country absent here states no postcode.
 */

/**
 * One country's postcode format as libaddressinput states it.
 */
export interface CountryPostcodeFormatSource {
	/**
	 * The \`zip\` pattern, unanchored, in the regex subset JavaScript and Python share.
	 */
	readonly pattern: string
	/**
	 * The literal the country's layout prints immediately before the postcode, such as \`MD-\`.
	 */
	readonly prefix?: string
}

/**
 * Postcode formats keyed by ISO 3166-1 alpha-2.
 */
export const COUNTRY_POSTCODE_FORMAT_SOURCES: Readonly<Record<string, CountryPostcodeFormatSource>> = {
${entries.join("\n")}
}
`

const outPath = resolvePackageDirectory("@mailwoman/codex")("lib", "postcode", "country-formats", "data.ts")

await writeLocalTextFile(emitted, outPath)

console.log(`wrote ${entries.length} postcode formats to ${outPath}. ${withoutPattern} countries state no zip pattern`)
