/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `pk-register` and `bd-register` slice recipes — the typed forms of Pakistan and Bangladesh the country templates do
 *   not render, over the OpenStreetMap corpus JSONL the `osm` adapter reads (#1744, the F8 family). The adapter's own
 *   rows carry the template shape (`4 38th Street, DHA Phase 6, Karachi`; `24 Road 104, Dhaka - 1207`); these two carry
 *   the register:
 *
 *   - the HOUSE line, `House 4, Street 25, F-7/2, Islamabad` and `House 34, Road 4, Sector 9, Uttara, Dhaka 1230` —
 *     `House` in front of the number (untagged, the same rule as Singapore's `Blk`), the numbered street, the scheme or
 *     sector as the dependent locality, the city;
 *   - the PLAIN line with the trailing postcode and no dash, `58 Kalabagan 1st Ln, Dhaka 1205` — what a person types,
 *     where the template writes `Dhaka - 1205`.
 *
 *   Islamabad's sector codes (`F-7/2`, `G-10/3`) are the one synthesized value: the register carries them on a handful
 *   of rows, mostly inside `addr:city` (`F7/2 Islamabad`), so a row whose city is Islamabad and whose scheme is unknown
 *   draws one from the capital's grid. Every other value is the row's own. The components are the `osm` adapter's
 *   mapping (`componentsForOSMRow`), so the two surfaces cannot disagree about what a field means.
 *
 *   ⚠ ODbL: the rows inherit OpenStreetMap's share-alike license, and `--exclude-share-alike` drops them.
 *
 *   Run: mailwoman corpus slice pk-register --input <osm-pk.corpus.jsonl> --count N --seed S
 */

import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { componentsForOSMRow, OSM_LICENSE, sameName } from "#adapters/osm/adapter"
import { alignAndWrite, type CorpusRecipe, readTuples, type SliceRecipeOpts, sliceSourceID } from "#recipes/scaffold"
import type { CanonicalRow } from "#types"

/**
 * Islamabad's residential sectors: the lettered rows E to I, the numbered columns the Capital Development Authority has
 * developed, and the four sub-sectors each splits into.
 */
const ISLAMABAD_SECTOR_ROWS = ["E", "F", "G", "I"] as const
const ISLAMABAD_SECTOR_COLUMNS = [6, 7, 8, 9, 10, 11] as const
const ISLAMABAD_SUB_SECTORS = [1, 2, 3, 4] as const

/**
 * Share of rows rendered in the house register; the rest take the plain line.
 */
const P_HOUSE = 0.55

/**
 * Share of house lines that spell the number `House No. 4` / `House # 4` rather than `House 4`.
 */
const P_HOUSE_NO = 0.25

export type SouthAsiaRegister = "house" | "plain"

export interface SouthAsiaRendering {
	raw: string
	components: Record<string, string>
	register: SouthAsiaRegister
}

/**
 * Draw one Islamabad sector code, `F-7/2`.
 */
export function drawIslamabadSector(random: () => number): string {
	const row = ISLAMABAD_SECTOR_ROWS[Math.floor(random() * ISLAMABAD_SECTOR_ROWS.length)]!
	const column = ISLAMABAD_SECTOR_COLUMNS[Math.floor(random() * ISLAMABAD_SECTOR_COLUMNS.length)]!
	const sub = ISLAMABAD_SUB_SECTORS[Math.floor(random() * ISLAMABAD_SUB_SECTORS.length)]!

	return `${row}-${column}/${sub}`
}

/**
 * Render one register line from the adapter's components. Returns null when the row has no house number or no locality:
 * both registers need the two.
 */
export function renderSouthAsiaRegister(
	components: CanonicalRow["components"],
	random: () => number,
	register?: SouthAsiaRegister
): SouthAsiaRendering | null {
	const { house_number: number, street, locality, postcode } = components

	if (!number || !street || !locality) return null

	let dependent = components.dependent_locality

	if (!dependent && sameName(locality, "Islamabad")) {
		dependent = drawIslamabadSector(random)
	}

	const chosen = register ?? (random() < P_HOUSE ? "house" : "plain")
	const out: Record<string, string> = { house_number: number, street, locality }
	const tail = postcode ? `${locality} ${postcode}` : locality

	if (postcode) {
		out.postcode = postcode
	}

	if (dependent) {
		out.dependent_locality = dependent
	}

	const middle = dependent ? `${street}, ${dependent}` : street

	if (chosen === "house") {
		const spelling = random() < P_HOUSE_NO ? (random() < 0.5 ? "House No. " : "House # ") : "House "

		return { raw: `${spelling}${number}, ${middle}, ${tail}`, components: out, register: "house" }
	}

	return { raw: `${number} ${middle}, ${tail}`, components: out, register: "plain" }
}

function makeRecipe(name: string, country: "PK" | "BD", locale: string, description: string): CorpusRecipe {
	const source = `synth-${name}`

	return {
		name,
		description,
		mode: "tuples",
		options: [
			{ flag: "--count", description: "Rows to emit (default: every input row once)" },
			{
				flag: "--input",
				description: `The OpenStreetMap ${country} corpus JSONL (osm-${country.toLowerCase()}.corpus.jsonl)`,
			},
		],
		async run(opts: SliceRecipeOpts, write) {
			if (!opts.input) {
				throw new Error(`${name}: --input <osm-${country.toLowerCase()}.corpus.jsonl> is required`)
			}

			const random = makeMulberry32(opts.seed)
			const sourceName = opts.sourceName ?? source
			const registers: Record<string, number> = {}
			let read = 0
			let emitted = 0
			let skipped = 0
			let quarantined = 0

			for await (const tuple of readTuples(opts.input)) {
				read++

				if (opts.count !== undefined && emitted >= opts.count) break

				const components = componentsForOSMRow(tuple as Parameters<typeof componentsForOSMRow>[0])
				const rendering = components ? renderSouthAsiaRegister(components, random) : null

				if (!rendering) {
					skipped++

					continue
				}

				if (opts.golden) {
					write(JSON.stringify({ raw: rendering.raw, components: rendering.components, country, locale }) + "\n")

					emitted++
					registers[rendering.register] = (registers[rendering.register] ?? 0) + 1

					continue
				}

				const ok = alignAndWrite(
					write,
					{
						raw: rendering.raw,
						components: rendering.components,
						country,
						locale,
						source: sourceName,
						source_id: sliceSourceID(sourceName, { raw: rendering.raw }),
						corpus_version: "0.1.0",
						license: OSM_LICENSE,
					},
					`${name}:${rendering.register}`
				)

				if (ok) {
					emitted++
					registers[rendering.register] = (registers[rendering.register] ?? 0) + 1
				} else {
					quarantined++
				}
			}

			console.error(
				`  ${name}: ${emitted} emitted (${Object.entries(registers)
					.map(([k, v]) => `${k} ${v}`)
					.join(", ")}), ${skipped} skipped, ${quarantined} quarantined of ${read} read`
			)

			return { read, emitted, skipped }
		},
	}
}

/**
 * Pakistan: `House 4, Street 25, F-7/2, Islamabad` and `B230 Street 5, Block 3, Karachi`.
 */
export const pkRegisterRecipe: CorpusRecipe = makeRecipe(
	"pk-register",
	"PK",
	"en-PK",
	"Pakistan typed registers over the OpenStreetMap rows: the House line with the sector or scheme, the plain line with the trailing postcode"
)

/**
 * Bangladesh: `House 34, Road 4, Sector 9, Uttara, Dhaka 1230` and `58 Kalabagan 1st Ln, Dhaka 1205`.
 */
export const bdRegisterRecipe: CorpusRecipe = makeRecipe(
	"bd-register",
	"BD",
	"en-BD",
	"Bangladesh typed registers over the OpenStreetMap rows: the House line, the plain line with the trailing postcode and no dash"
)
