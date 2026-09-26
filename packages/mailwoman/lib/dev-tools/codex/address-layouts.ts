/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate `@mailwoman/codex`'s per-country layout table from libaddressinput's `fmt` skeleton and
 *   `street-orders.ts`, which supplies the street order `%A` leaves opaque, so the table is derived rather than
 *   transcribed.
 *
 *   Usage: `node packages/mailwoman/lib/dev-tools/codex/address-layouts.ts`
 */

import { ADDRESS_LAYOUTS } from "@mailwoman/codex/address-layouts"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { Globerator } from "spliterator/node/fs"

import {
	COMMA_JOINED_STREET_COUNTRIES,
	LOCAL_STREET_NODES,
	STREET_ORDERS,
	type StreetOrder,
} from "#dev-tools/codex/street-orders"
import { NO_SUB_LOCALITY_LINE_COUNTRIES } from "#dev-tools/codex/sub-locality-line"

interface AddressMetadata {
	readonly fmt?: string
	/**
	 * The latin-script print order, where the country writes one differently from its own script.
	 */
	readonly lfmt?: string
}

/**
 * Libaddressinput placeholder → the slot a layout names, where `%A` maps to a
 * marker the emitter replaces with a street node.
 */
const FIELD: Readonly<Record<string, string>> = {
	N: "attention",
	O: "venue",
	A: "STREET",
	D: "dependent_locality",
	C: "locality",
	S: "region",
	Z: "postcode",
	X: "cedex",
	R: "country",
}

/**
 * The countries whose hand-authored layout a generated skeleton never overwrites,
 * read from `ADDRESS_LAYOUTS` itself so the membership is not stated twice.
 */
const HAND_AUTHORED = new Set(Object.keys(ADDRESS_LAYOUTS))

/**
 * Whether the rendered lines print the largest unit first, read off the skeleton
 * because the generator runs before the layouts it would otherwise consult.
 */
function printsLargestFirst(lines: readonly string[]): boolean {
	const region = lines.findIndex((line) => line.includes("${region}"))
	const street = lines.findIndex((line) => line.includes("Street}") || line.includes("${house_number}"))

	return region !== -1 && street !== -1 && region < street
}

/**
 * Render one `fmt` into template source, adding every slot it names to `slots`
 * so the emitted file destructures exactly what it uses.
 */
function layoutSource(
	fmt: string,
	code: string,
	order: StreetOrder,
	slots: Set<string>,
	localScript = false
): string | null {
	const comma = COMMA_JOINED_STREET_COUNTRIES.has(code) ? "Comma" : ""

	const streetNode =
		localScript && LOCAL_STREET_NODES[code] === "han"
			? "hanStreet"
			: order === "number-first"
				? `numberFirst${comma}Street`
				: `numberLast${comma}Street`

	streetNodes.add(streetNode)
	const lines: string[] = []
	const named = new Set<string>()

	for (const rawLine of fmt.split("%n")) {
		let line = ""
		let sawField = false

		for (let index = 0; index < rawLine.length; index++) {
			if (rawLine[index] === "%") {
				const field = FIELD[rawLine[++index]!]

				if (!field) continue

				sawField = true

				if (field === "STREET") {
					line += `\${${streetNode}}`
				} else {
					named.add(field)
					line += `\${${field}}`
				}

				continue
			}

			line += rawLine[index]
		}

		if (sawField) {
			lines.push(line.trim())
		}
	}

	if (!lines.length) return null

	// The sub-locality line is authored wherever `%D` is absent, placed directly
	// above the locality in the skeleton's own direction.
	if (!NO_SUB_LOCALITY_LINE_COUNTRIES.has(code) && !named.has("dependent_locality")) {
		const street = `\${${streetNode}}`
		const localityLine = lines.findIndex((line) => line.includes("${locality}"))
		const streetLine = lines.findIndex((line) => line.includes(street))

		if (localityLine !== -1) {
			named.add("dependent_locality")

			if (streetLine === localityLine) {
				const line = lines[localityLine]!
				const streetLeads = line.indexOf(street) < line.indexOf("${locality}")

				lines[localityLine] = line.replace(
					"${locality}",
					streetLeads ? "${dependent_locality} ${locality}" : "${locality} ${dependent_locality}"
				)
			} else {
				lines.splice(streetLine > localityLine ? localityLine + 1 : localityLine, 0, "${dependent_locality}")
			}
		}
	}

	// The country line is authored rather than transcribed, because libaddressinput leaves `%R`
	// out of nearly every `fmt`; it opens a largest-first address and closes a smallest-first one.
	if (!named.has("country")) {
		named.add("country")

		if (printsLargestFirst(lines)) {
			lines.unshift("${country}")
		} else {
			lines.push("${country}")
		}
	}

	for (const slot of named) {
		slots.add(slot)
	}

	return lines.join("\n")
}

const specsDirectory = resolvePackageDirectory("@mailwoman/core")("data", "chromium-i18n", "ssl-address")
const entries: string[] = []
const latinEntries: string[] = []
const localEntries: string[] = []
const usedSlots = new Set<string>()
const streetNodes = new Set<string>()
let withoutFormat = 0

for (const file of await Globerator.files("json", {
	cwd: specsDirectory,
	absolute: false,
	recursive: false,
}).toSorted()) {
	const code = file.replace(/\.json$/, "")
	const metadata = await readLocalJSONFile<AddressMetadata>(specsDirectory(file))
	const order = STREET_ORDERS[code] ?? "number-first"

	// The Latin skeleton is emitted for a hand-authored country too, because the
	// hand-authored table states one order per country and a country whose two scripts
	// disagree has no way to carry the second there.
	if (metadata.lfmt && metadata.fmt && metadata.lfmt !== metadata.fmt) {
		const latin = layoutSource(metadata.lfmt, code, order, usedSlots)
		const local = layoutSource(metadata.fmt, code, order, usedSlots, true)

		if (latin) {
			latinEntries.push(`\t// ${metadata.lfmt.replaceAll("\n", "\\n")}\n\t${code}: addr\`${latin}\`,`)
		}

		if (local) {
			localEntries.push(`\t// ${metadata.fmt.replaceAll("\n", "\\n")}\n\t${code}: addr\`${local}\`,`)
		}
	}

	if (HAND_AUTHORED.has(code)) continue

	if (!metadata.fmt) {
		withoutFormat++

		continue
	}

	const source = layoutSource(metadata.fmt, code, order, usedSlots)

	if (!source) {
		withoutFormat++

		continue
	}

	entries.push(`\t// ${metadata.fmt.replaceAll("\n", "\\n")}\n\t${code}: addr\`${source}\`,`)
}

const emitted = `/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @generated
 *
 *   generated — run \`node packages/mailwoman/lib/dev-tools/codex/address-layouts.ts\` to refresh. Do not edit by hand.
 *
 *   One layout per country, derived from libaddressinput's \`fmt\` skeleton (which fields print, in what order) and the
 *   street order read once from the OpenCage templates (which slot leads). The \`fmt\` each was derived from is quoted
 *   above it, so a reader can compare the two without opening the dataset.
 *
 *   The locales this project publishes weights for are not here: those are hand-authored in the sibling \`index.ts\` and
 *   checked against real addresses on a board, because a generated skeleton is a starting point rather than a verdict.
 *
 *   The Latin table below is the exception to that split. A hand-authored entry states one order per country, so a
 *   country whose two scripts disagree cannot carry its second order there — Hong Kong's hand-authored layout is the
 *   Latin one, which leaves the Chinese order with nowhere to live. The Latin skeletons are therefore generated for
 *   every country that has one, hand-authored or not.
 */

// oxlint-disable max-lines -- one entry per country, each a template that reads in the order it prints

import { addr, ${[...streetNodes].toSorted().join(", ")}, SLOTS, type AddressLayout } from "#address/layout"

const { ${[...usedSlots].toSorted().join(", ")} } = SLOTS

/**
 * Generated layouts, keyed by ISO 3166-1 alpha-2.
 */
export const GENERATED_ADDRESS_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
${entries.join("\n\n")}
}

/**
 * latin-script layouts, for the countries whose Latin print order differs from the one in their own script.
 *
 * Keyed by ISO 3166-1 alpha-2, and sparse on purpose: a country absent here writes one order in both scripts, so its
 * country-keyed layout serves both. The \`lfmt\` each was derived from is quoted above it.
 */
export const GENERATED_LATIN_ADDRESS_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
${latinEntries.join("\n\n")}
}

/**
 * local-script layouts for the same countries — the \`fmt\` skeleton, emitted even where the country is hand-authored.
 *
 * A hand-authored entry states one order, and for Hong Kong that order is the Latin one, so its own script's order has
 * nowhere else to live. Sparse for the same reason as the Latin table: a country absent here writes one order in both.
 */
export const GENERATED_LOCAL_ADDRESS_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
${localEntries.join("\n\n")}
}
`

const outPath = resolvePackageDirectory("@mailwoman/codex")("lib", "address", "layouts", "generated.ts")

await writeLocalTextFile(emitted, outPath)

console.log(
	`wrote ${entries.length} layouts and ${latinEntries.length} Latin variants to ${outPath}; ` +
		`${withoutFormat} countries carry no usable fmt`
)
