/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate `@mailwoman/codex`'s per-country layout table from the two reference sources, so the table is derived
 *   rather than transcribed and a refresh of either source shows up as a reviewable diff.
 *
 *   two sources, because neither alone says what a layout needs:
 *
 *   1. **libaddressinput** (`core/data/chromium-i18n/ssl-address/<CC>.json`, Apache-2.0, already shipped and already
 *      refreshable through `mailwoman dev download ssl-address`) supplies the line skeleton in its `fmt` field — which
 *      fields print, in what order, with the line breaks between them.
 *   2. **`street-orders.ts`**, beside this file, supplies the street order, because libaddressinput models the street
 *      address as one opaque `%A` field and says nothing about whether the house number leads or follows. That table
 *      was read once from the OpenCage `address-formatting` templates and committed as data, so this generator needs no
 *      third-party package. its own header says how to refresh it.
 *
 *   The hand-authored layouts in `codex/lib/address/layouts/index.ts` take precedence for the locales this project
 *   publishes weights for: those are checked against real addresses on a board, and a generated skeleton is a starting
 *   point rather than a verdict.
 *
 *   Usage: `node packages/mailwoman/lib/dev-tools/codex/address-layouts.ts`
 */

import { ADDRESS_LAYOUTS } from "@mailwoman/codex/address-layouts"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { join } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import {
	COMMA_JOINED_STREET_COUNTRIES,
	LOCAL_STREET_NODES,
	STREET_ORDERS,
	type StreetOrder,
} from "#dev-tools/codex/street-orders"
import { NO_SUB_LOCALITY_LINE_COUNTRIES } from "#dev-tools/codex/sub-locality-line"

/**
 * Libaddressinput's per-country record, narrowed to the field a layout reads.
 */
interface AddressMetadata {
	readonly fmt?: string
	/**
	 * The latin-script print order, where the country writes one differently from its own script.
	 *
	 * Eight of the 252 shipped records carry one that differs from `fmt`: CN, HK, JP, KP,
	 * KR, MO, TH, TW. Hong Kong is the worked case — `%S%n%C%n%A%n%O%n%N` largest-first
	 * against `%N%n%O%n%A%n%C%n%S` smallest-first — and reading `fmt` alone gave the
	 * Chinese field order carried by Latin separators, an order no register uses.
	 */
	readonly lfmt?: string
}

/**
 * Libaddressinput placeholder → the slot a layout names.
 * `%A` is the street line, which each system expands into this project's finer tags.
 * Therefore, it maps to a marker the emitter replaces with a street node.
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
 * The countries whose layout is hand-authored and checked on the locale board.
 * A generated skeleton never overwrites one of these.
 *
 * Read from `ADDRESS_LAYOUTS` itself. A list here is the same membership stated twice,
 * and the two fall out of step silently: a country authored in the table but missing
 * from the list is emitted into both, which `layout-table-source.test.ts` catches,
 * and one listed but never authored loses its layout, which nothing catches.
 */
const HAND_AUTHORED = new Set(Object.keys(ADDRESS_LAYOUTS))

/**
 * Whether the lines rendered so far print the largest unit first — the region ahead of the street.
 *
 * Read off the skeleton rather than from a country list.
 * The generator runs before the layout it is writing exists, so it cannot consult `@mailwoman/codex`'s
 * `LARGEST_FIRST_SYSTEMS`, which derives from those layouts. the `fmt` in hand carries the
 * same statement. A hand-kept list here held JP, CN, TW and KR while the dataset printed
 * largest-first for IR, KP and KZ as well, and those three took a trailing country line.
 */
function printsLargestFirst(lines: readonly string[]): boolean {
	const region = lines.findIndex((line) => line.includes("${region}"))
	const street = lines.findIndex((line) => line.includes("Street}") || line.includes("${house_number}"))

	return region !== -1 && street !== -1 && region < street
}

/**
 * Render one `fmt` into the template source a layout is written as, or null
 * when it names no field this project models.
 *
 * Every slot the source names is added to `slots`, so the emitted file destructures
 * exactly what it uses — a destructured slot no layout reaches is an unused binding,
 * which the linter reports against a file nobody edits.
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

	// The sub-locality line is authored wherever `%D` is absent, because the
	// formatter this table replaces printed one for 202 of its 213 countries.
	// It goes directly above the locality, which is where every template that has one puts it;
	// `NO_SUB_LOCALITY_LINE_COUNTRIES` names the eleven that print none.
	//
	// "Above" is the envelope's sense — nearer the street than the locality is — and
	// which side of the locality line that is depends on the skeleton's direction.
	// A smallest-first skeleton prints the street before the locality, so the line goes
	// before the locality. a largest-first one prints the locality before the street,
	// so the line goes after it — and after the whole line, since a skeleton like `%S%C`
	// keeps the region and the locality together, and a district spliced ahead of that line
	// would print above the region. A skeleton that puts the street and the locality on one
	// line (`%A %C`) takes the slot inside that line, between the two, for the same reason.
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

	// The country line is authored rather than transcribed: libaddressinput leaves `%R` out
	// of nearly every `fmt` because its consumers add the destination country themselves.
	// It closes a small-first address and opens a large-first one, and it renders only
	// when a caller supplies the name — an intra-country row carries none and prints none.
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

const specsDirectory = resolvePackagePath("@mailwoman/core", "data", "chromium-i18n", "ssl-address")
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
	const metadata = await readLocalJSONFile<AddressMetadata>(join(specsDirectory, file))
	const order = STREET_ORDERS[code] ?? "number-first"

	// The Latin skeleton is emitted for a hand-authored country too.
	// The hand-authored table states one order per country, so a country whose two scripts
	// disagree has no way to carry the second there, and Hong Kong is the case that shows it:
	// its hand-authored layout is the Latin one, which leaves the Chinese order unreachable.
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

const outPath = resolvePackagePath("@mailwoman/codex", "lib", "address", "layouts", "generated.ts")

await writeLocalTextFile(emitted, outPath)

console.log(
	`wrote ${entries.length} layouts and ${latinEntries.length} Latin variants to ${outPath}; ` +
		`${withoutFormat} countries carry no usable fmt`
)
