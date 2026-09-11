/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate `@mailwoman/codex`'s per-country layout table from the two reference sources, so the table is derived
 *   rather than transcribed and a refresh of either source shows up as a reviewable diff.
 *
 *   TWO SOURCES, because neither alone says what a layout needs:
 *
 *   1. **libaddressinput** (`core/data/chromium-i18n/ssl-address/<CC>.json`, Apache-2.0, already shipped and already
 *      refreshable through `mailwoman dev download ssl-address`) supplies the line SKELETON in its `fmt` field — which
 *      fields print, in what order, with the line breaks between them.
 *   2. **The OpenCage templates** supply the street ORDER, because libaddressinput models the street address as one
 *      opaque `%A` field and says nothing about whether the house number leads or follows. That is read ONCE, here, and
 *      committed as data; the dependency is then removed, which is the point of generating rather than calling.
 *
 *   The hand-authored layouts in `codex/lib/address-layouts.ts` take precedence for the locales this project publishes
 *   weights for: those are checked against real addresses on a board, and a generated skeleton is a starting point
 *   rather than a verdict.
 *
 *   Usage: `node packages/mailwoman/lib/dev-tools/codex/address-layouts.ts`
 */

import { readDirectory, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { join } from "path-ts"

/**
 * Libaddressinput's per-country record, narrowed to the field a layout reads.
 */
interface AddressMetadata {
	readonly fmt?: string
}

/**
 * Where the house number sits relative to the street name. Two orders cover 183 of the 211 countries whose OpenCage
 * template names both slots; the rest differ only in the separator, which the skeleton already carries.
 */
type StreetOrder = "number-first" | "number-last"

/**
 * Libaddressinput placeholder → the slot a layout names. `%A` is the street line, which each system expands into this
 * project's finer tags, so it maps to a marker the emitter replaces with a street node.
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
 * The countries whose layout is hand-authored and checked on the locale board. A generated skeleton never overwrites
 * one of these.
 */
const HAND_AUTHORED = new Set(["US", "FR", "GB", "DE", "ES", "IT", "IN", "NZ", "AU", "JP", "CN"])

/**
 * Read the street order per country from the OpenCage templates, once.
 *
 * This is the half libaddressinput does not carry. Reading it at generation time and committing the result is what lets
 * the dependency go: the templates are never consulted at runtime.
 */
async function readStreetOrders(): Promise<Map<string, StreetOrder>> {
	const templatesPath = resolvePackagePath("@fragaria/address-formatter", "src", "templates", "templates.json")
	const templates = await readLocalJSONFile<Record<string, { address_template?: string }>>(templatesPath)
	const orders = new Map<string, StreetOrder>()

	for (const [code, definition] of Object.entries(templates)) {
		if (!/^[A-Z]{2}$/.test(code)) continue

		const template = definition.address_template

		if (!template) continue

		// A `{{#first}}` alternation names `road` as a FALLBACK for a place name, which is not the street line. Collapse
		// each alternation to the road it may contain so the position read below is the real one.
		const stripped = template.replaceAll(/\{\{#first\}\}[\s\S]*?\{\{\/first\}\}/g, (block) =>
			block.includes("{{{road}}}") ? "{{{road}}}" : ""
		)

		const road = stripped.indexOf("{{{road}}}")
		const number = stripped.indexOf("{{{house_number}}}")

		if (road === -1 || number === -1) continue

		orders.set(code, number < road ? "number-first" : "number-last")
	}

	return orders
}

/**
 * Render one `fmt` into the template source a layout is written as, or null when it names no field this project models.
 *
 * Every slot the source names is added to `slots`, so the emitted file destructures exactly what it uses — a
 * destructured slot no layout reaches is an unused binding, which the linter reports against a file nobody edits.
 */
function layoutSource(fmt: string, order: StreetOrder, slots: Set<string>): string | null {
	const streetNode = order === "number-first" ? "numberFirstStreet" : "numberLastStreet"
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

	for (const slot of named) {
		slots.add(slot)
	}

	return lines.join("\n")
}

const specsDirectory = resolvePackagePath("@mailwoman/core", "data", "chromium-i18n", "ssl-address")
const orders = await readStreetOrders()
const entries: string[] = []
const usedSlots = new Set<string>()
let withoutFormat = 0

for (const file of (await readDirectory(specsDirectory)).toSorted()) {
	if (!file.endsWith(".json")) continue

	const code = file.replace(/\.json$/, "")

	if (HAND_AUTHORED.has(code)) continue

	const metadata = await readLocalJSONFile<AddressMetadata>(join(specsDirectory, file))

	if (!metadata.fmt) {
		withoutFormat++

		continue
	}

	const source = layoutSource(metadata.fmt, orders.get(code) ?? "number-first", usedSlots)

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
 *
 *   GENERATED — run \`node packages/mailwoman/lib/dev-tools/codex/address-layouts.ts\` to refresh. Do not edit by hand.
 *
 *   One layout per country, derived from libaddressinput's \`fmt\` skeleton (which fields print, in what order) and the
 *   street order read once from the OpenCage templates (which slot leads). The \`fmt\` each was derived from is quoted
 *   above it, so a reader can compare the two without opening the dataset.
 *
 *   The locales this project publishes weights for are NOT here: those are hand-authored in \`address-layouts.ts\` and
 *   checked against real addresses on a board, because a generated skeleton is a starting point rather than a verdict.
 */

// oxlint-disable max-lines -- one entry per country, each a template that reads in the order it prints

import { addr, numberFirstStreet, numberLastStreet, SLOTS, type AddressLayout } from "#address-layout"

const { ${[...usedSlots].toSorted().join(", ")} } = SLOTS

/**
 * Generated layouts, keyed by ISO 3166-1 alpha-2.
 */
export const GENERATED_ADDRESS_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
${entries.join("\n\n")}
}
`

const outPath = resolvePackagePath("@mailwoman/codex", "lib", "address-layouts-generated.ts")

await writeLocalTextFile(emitted, outPath)

console.log(`wrote ${entries.length} layouts to ${outPath}; ${withoutFormat} countries carry no usable fmt`)
