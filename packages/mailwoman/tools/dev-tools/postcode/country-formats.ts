/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate `@mailwoman/postcode`'s per-country postcode formats from libaddressinput's `zip` pattern and the
 *   literal its `fmt` prints ahead of `%Z` (`MD-%Z`, `AX-%Z`) and whether `fmt` prints `%Z` before or after `%C`, so
 *   the table is derived rather than transcribed.
 *
 *   Usage: `node packages/mailwoman/tools/dev-tools/postcode/country-formats.ts`
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { sslAddressSpecsPath } from "@mailwoman/dictionaries/paths"
import { Globerator } from "spliterator/node/fs"

import {
	type PostcodeAdminBlockSide,
	placementInFormat,
	POSTCODE_LAYOUTS_PATH,
	postcodeSideOfAdminBlock,
} from "./fmt-placement.ts"

interface AddressMetadata {
	readonly fmt?: string
	readonly zip?: string
	readonly sub_keys?: string
	readonly sub_isoids?: string
	readonly sub_zips?: string
}

/**
 * One subregion's postcode prefix pattern, as `subregions.json` records it.
 */
interface SubregionPostcodeSource {
	readonly key: string
	readonly isoid: string | null
	readonly prefix: string
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

const specsDirectory = sslAddressSpecsPath()
const entries: string[] = []
const subregions: Record<string, SubregionPostcodeSource[]> = {}
const adminBlockSides: Record<string, PostcodeAdminBlockSide | null> = {}
let withoutPattern = 0

for (const file of await Globerator.files("json", {
	cwd: specsDirectory,
	absolute: false,
	recursive: false,
}).toSorted()) {
	const code = file.replace(/\.json$/, "")
	const metadata = await readLocalJSONFile<AddressMetadata>(specsDirectory(file))

	// Every layout that prints a postcode gets an entry.
	// Null records a layout with no `%C`.
	// A country whose layout prints no postcode has no entry, so a reader can tell the two apart.
	if (metadata.fmt?.includes("%Z")) {
		adminBlockSides[code] = postcodeSideOfAdminBlock(metadata.fmt)
	}

	if (!metadata.zip) {
		withoutPattern++

		continue
	}

	// Refuse a pattern JavaScript cannot compile, rather than emitting a table that throws at module load.
	new RegExp(`^(?:${metadata.zip})$`, "iu")

	if (metadata.sub_zips) {
		const keys = metadata.sub_keys?.split("~") ?? []
		const isoids = metadata.sub_isoids?.split("~") ?? []
		const zips = metadata.sub_zips.split("~")

		if (zips.length !== keys.length) {
			throw new Error(`${code}: ${zips.length} sub_zips against ${keys.length} sub_keys`)
		}

		const rows = zips.flatMap((zip, i) => {
			if (!zip) return []

			// The same refusal as above, for a prefix pattern.
			new RegExp(`^(?:${zip})`, "iu")

			return [{ key: keys[i]!, isoid: isoids[i] || null, prefix: zip }]
		})

		if (rows.length) {
			subregions[code] = rows
		}
	}

	const prefix = postcodePrefix(metadata.fmt)
	const pattern = stringifyJSON(metadata.zip)
	const placement = placementInFormat(metadata.fmt)

	const fields = [
		...(prefix ? [`prefix: ${stringifyJSON(prefix)}`] : []),
		...(placement ? [`postcodePlacement: ${stringifyJSON(placement)}`] : []),
	]

	const inline = `\t${code}: { ${[`pattern: ${pattern}`, ...fields].join(", ")} },`
	const patternLine = `\t\tpattern: ${pattern},`

	// The repository formatter breaks an entry wider than its print width onto one line per field,
	// and breaks the pattern after its key only when the pattern line is itself too wide.
	// The generator writes that form itself, so the output needs no formatting pass.
	const patternLines =
		patternLine.replaceAll("\t", "    ").length <= PRINT_WIDTH ? [patternLine] : [`\t\tpattern:`, `\t\t\t${pattern},`]

	entries.push(
		inline.replace("\t", "    ").length <= PRINT_WIDTH
			? inline
			: [`\t${code}: {`, ...patternLines, ...fields.map((field) => `\t\t${field},`), `\t},`].join("\n")
	)
}

const emitted = `/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @generated
 *
 *   generated — run \`node packages/mailwoman/tools/dev-tools/postcode/country-formats.ts\` to refresh. Do not edit by hand.
 *
 *   One postcode format per country that libaddressinput states one for: its \`zip\` pattern, the country-code
 *   prefix its \`fmt\` prints ahead of the postcode, and whether its \`fmt\` prints the postcode before or after the
 *   locality. A country absent here states no postcode.
 */

/**
 * Where a country's layout prints the postcode relative to the locality.
 */
export type PostcodeLocalityPlacement = "before_locality" | "after_locality"

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
	/**
	 * Whether \`fmt\` prints \`%Z\` before or after \`%C\`.
	 * Absent when the layout prints only one of the two.
	 */
	readonly postcodePlacement?: PostcodeLocalityPlacement
}

/**
 * Postcode formats keyed by ISO 3166-1 alpha-2.
 */
export const COUNTRY_POSTCODE_FORMAT_SOURCES: Readonly<Record<string, CountryPostcodeFormatSource>> = {
${entries.join("\n")}
}
`

const outPath = resolvePackageDirectory("@mailwoman/postcode")("lib", "country-formats", "data.ts")

await writeLocalTextFile(emitted, outPath)

console.log(`wrote ${entries.length} postcode formats to ${outPath}. ${withoutPattern} countries state no zip pattern`)

const subregionsPath = resolvePackageDirectory("@mailwoman/postcode")("lib", "subregions.json")

await writeLocalTextFile(prettyJSON(subregions), subregionsPath)

console.log(
	`wrote ${Object.values(subregions).flat().length} subregion prefixes for ${Object.keys(subregions).length} countries to ${subregionsPath}`
)

const layoutsPath = repoRootPathBuilder(...POSTCODE_LAYOUTS_PATH)

await writeLocalTextFile(
	prettyJSON({
		$comment:
			"Generated by `node packages/mailwoman/tools/dev-tools/postcode/country-formats.ts` from libaddressinput's `fmt`. Do not edit by hand. Each country whose layout prints a postcode maps to where it prints it relative to the block its locality (%C) and region (%S) form: before, after or between. Null is a layout that prints no %C (JP, SG, GI, KY). The training-time postcode_move augmentation reads it.",
		countries: adminBlockSides,
	}),
	layoutsPath
)

console.log(`wrote the postcode side of ${Object.keys(adminBlockSides).length} layouts to ${layoutsPath}`)
