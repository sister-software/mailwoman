// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The per-country layout table lists entries in print order.
 *
 *   Readers can check a country by inspecting an address shape instead of tracing nested calls.
 *
 *   The line skeletons come from libaddressinput, Google's address metadata.
 *   This repository ships the data at `packages/dictionaries/data/chromium-i18n/ssl-address/`
 *   (252 countries, Apache-2.0).
 *
 *   Its `fmt` field is the print order.
 *   This repository supplies the `%A` expansion into its street tags, the line-join
 *   policy, the country line and the post-office box.
 */

import {
	ConventionClaimID,
	conventionObservation,
	ConventionSource,
	ObservationStance,
	stanceFromLayout,
	type ConventionClaim,
	type ConventionObservation,
	type LayoutCitation,
	reorderedPairs,
} from "#address/convention-claims"
import {
	addr,
	type AddressAtom,
	type AddressLayout,
	hanStreet,
	isAlternation,
	isLayout,
	isSlot,
	numberFirstCommaStreet,
	numberFirstStreet,
	numberLastCommaStreet,
	numberLastStreet,
	prefixedSlot,
	SLOTS,
	unitFirstStreet,
	unitLineNumberFirstStreet,
	withPoBoxBelow,
	withSoftBreakBefore,
} from "#address/layout"
import { LAYOUT_CITATIONS } from "#address/layouts/citations"
import { LATIN_LAYOUT_CITATIONS } from "#address/layouts/citations/latin"
import { UPU_PAS_LAYOUT_RECORDS } from "#address/layouts/description-records"
import {
	GENERATED_ADDRESS_LAYOUTS,
	GENERATED_LATIN_ADDRESS_LAYOUTS,
	GENERATED_LOCAL_ADDRESS_LAYOUTS,
	HAND_AUTHORED_FORMAT_SKELETONS,
} from "#address/layouts/generated"
import { READ_LATIN_ADDRESS_LAYOUTS } from "#address/layouts/latin-readings"
import { S42_ADDRESS_LAYOUTS, S42_READ_LAYOUTS } from "#address/layouts/s42"
import { UNADDRESSED_JURISDICTIONS } from "#address/layouts/unaddressed"
import { UPU_PAS_ADDRESS_LAYOUTS } from "#address/layouts/upu-pas"
import { s42CohortForJurisdiction } from "#address/s42-templates"
import type { ComponentTag } from "#component"

/**
 * Which script an address is written in when a country writes two different orders:
 * `local` is the country's own script. libaddressinput's `fmt` states that order.
 * `latin` uses its `lfmt` value.
 *
 * Eight of the 252 shipped records define a distinct pair (CN, HK, JP, KP, KR, MO, TH, TW)
 * and every other country writes one order in both.
 */
export type AddressScript = "local" | "latin"

/**
 * Where each layout table's print order was read, quoted as the source's own identifier.
 *
 * The location is recorded per table rather than per entry because each table is derived by one
 * procedure from one input, so a per-entry copy could disagree with how its entry was produced.
 */
const READ_FROM = {
	generated: "libaddressinput `fmt`, via GENERATED_ADDRESS_LAYOUTS",
	latin: "libaddressinput `lfmt`, via GENERATED_LATIN_ADDRESS_LAYOUTS",
	street: "OpenCage address-formatting templates, via the street atom of the layout",
	board: "mailwoman locale board, via ADDRESS_LAYOUTS",
} as const

const { attention, venue, house_number, street, dependent_locality, locality, subregion, region, postcode, country } =
	SLOTS

/**
 * The admin run below the prefecture in Japan, printed without separators.
 *
 * Japan's `fmt` contains no `%C` or `%D`, so everything below the prefecture uses the street-address field.
 */
export const japaneseSubPrefecture = addr`${subregion}${locality}${dependent_locality}${house_number}`

/**
 * China's street line: the name then the number, unseparated, below an admin
 * run its `fmt` prints as `%S%C%D`.
 */
export const chineseStreet = addr`${street}${house_number}`

/**
 * How a system joins its lines for single-line output.
 *
 * An absent value means `", "`, the anglophone default.
 * CJK systems use different joins, so this setting belongs to each system instead of a caller argument.
 */
export const LINE_JOINS: Readonly<Record<string, string>> = {
	JP: " ",
	CN: "",
	TW: "",
	KR: " ",
	// Written in Han script the same way CN and TW are; {@link lineJoinForCountry} asks
	// which script first because Hong Kong's country answer is its English register.
	HK: "",
	MO: "",
	KP: " ",
}

/**
 * The order a country prints a value that pairs a local-script name with its Latin name.
 *
 * Hong Kong and Macau name streets and places in two official languages.
 * OpenStreetMap writes both names in one value there: `明安街 Ming On Street`, `林茂巷 Travessa de Lam Mau`.
 *
 * In the 2026-10-17 extract, 60,874 of 63,725 Hong Kong rows and 12,933 of
 * 12,975 Macau rows hold such a pair.
 * In Thailand, the other two-order country in that extract, 284 of about 45,000 rows do.
 *
 * The local order prints its lines, and a street and its number, with no separator.
 * That join is right between Han characters.
 *
 * Next to a Latin name it glues two words (`Quarry Bay祐民街`, `Yau Man Street6`).
 * The Latin order separates every value and puts the number where the Latin register
 * writes it: `6 祐民街 Yau Man Street, 鰂魚涌 Quarry Bay, 香港 Hong Kong`.
 *
 * A country absent from this table prints a paired value in its local order.
 */
export const NAME_PAIR_SCRIPTS: Readonly<Record<string, AddressScript>> = {
	HK: "latin",
	MO: "latin",
}

/**
 * Returns the order `countryCode` prints a value that pairs a local-script name
 * with its Latin name, or `null` when the country has none.
 */
export function namePairScriptForCountry(countryCode: string): AddressScript | null {
	return NAME_PAIR_SCRIPTS[countryCode.trim().toUpperCase()] ?? null
}

/**
 * The Latin-script layout of an uppercase `code`: a reading of the postal operator's document
 * where one replaces the libaddressinput `lfmt` skeleton, else that skeleton.
 */
function latinLayoutFor(code: string): AddressLayout | undefined {
	return READ_LATIN_ADDRESS_LAYOUTS[code] ?? GENERATED_LATIN_ADDRESS_LAYOUTS[code]
}

/**
 * Whether the country selected by `countryCode` prints the largest unit first, in `script`.
 *
 * Every country carrying a distinct Latin order writes it smallest-first,
 * read off the layout rather than encoded as a rule.
 */
export function isLargestFirstSystem(countryCode: string | null, script?: AddressScript): boolean {
	if (!countryCode) return false

	const code = countryCode.trim().toUpperCase()

	if (script === "latin") {
		const latin = latinLayoutFor(code)

		if (latin) return layoutPrintsLargestFirst(latin) === true
	}

	return LARGEST_FIRST_SYSTEMS.has(code)
}

/**
 * Which order a layout prints: `true` when its `region` line precedes its street line,
 * or `null` when the layout identifies no region or no street.
 *
 * A layout and {@link isLargestFirstSystem} can disagree, in which case an address
 * prints one system's sequence with another's separators; `layouts.test.ts`
 * compares the two for every country that has both.
 */
export function layoutPrintsLargestFirst(layout: AddressLayout): boolean | null {
	const tags = printedTags(layout)

	const regionAt = tags.indexOf("region")
	const streetAt = tags.findIndex((tag) => tag === "street" || tag === "house_number")

	if (regionAt === -1 || streetAt === -1) return null

	return regionAt < streetAt
}

/**
 * Whether a layout prints the component, so a row that omits it is still a complete row
 * of that country: the FR layout prints no `region`, and a FR row without one is whole.
 */
export function layoutPrintsTag(layout: AddressLayout, tag: ComponentTag): boolean {
	return printedTags(layout).includes(tag)
}

/**
 * Whether the layout prints the postcode before the locality, as FR and DE do,
 * or `null` when the layout prints one of the two and not the other.
 */
export function layoutPrintsPostcodeBeforeLocality(layout: AddressLayout): boolean | null {
	const tags = printedTags(layout)
	const postcodeAt = tags.indexOf("postcode")
	const localityAt = tags.indexOf("locality")

	if (postcodeAt === -1 || localityAt === -1) return null

	return postcodeAt < localityAt
}

/**
 * Whether the layout prints the house number before the street, as `221B Baker Street` does,
 * or `null` when the layout prints one of the two and not the other.
 */
export function layoutPrintsNumberBeforeStreet(layout: AddressLayout): boolean | null {
	const tags = printedTags(layout)
	const numberAt = tags.indexOf("house_number")
	const streetAt = tags.indexOf("street")

	if (numberAt === -1 || streetAt === -1) return null

	return numberAt < streetAt
}

/**
 * Every slot a layout prints, in print order, flattened across lines
 * rather than per line, because the CJK systems put the whole admin run on one line
 * and a comparison of line indices would read them as unordered.
 */
function printedTags(layout: AddressLayout): ComponentTag[] {
	const tags: ComponentTag[] = []

	const visit = (atom: AddressAtom): void => {
		if (isSlot(atom)) {
			tags.push(atom.tag)
		} else if (isLayout(atom)) {
			for (const line of atom.lines) {
				for (const inner of line) {
					visit(inner)
				}
			}
		} else if (isAlternation(atom)) {
			// An alternation never reorders region against street, so reading the first alternative is enough.
			for (const inner of atom.alternatives) {
				visit(inner)
			}
		}
	}

	visit(layout)

	return tags
}

/**
 * Lists layouts for locales where this project publishes weights.
 *
 * Each entry expands `%A` in the country's libaddressinput `fmt` skeleton.
 * The quoted `fmt` beside it lets readers compare the values without opening the dataset.
 */
export const ADDRESS_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
	// %N%n%O%n%A%n%C, %S %Z
	US: addr`${attention}
${venue}
${numberFirstStreet}
${locality}, ${region} ${postcode}
${country}`,

	// %O%n%N%n%A%n%Z %C, with La Poste's lines from its UPU description: the delivery point
	// (`Apartment 2`) above the street and the P.O. box (`BP 40122`) below it.
	FR: addr`${venue}
${attention}
${withPoBoxBelow(unitLineNumberFirstStreet)}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// %N%n%O%n%A%n%C%n%Z — the postcode takes its own line down the page and a space on one line.
	// The soft break expresses both rules in one layout and keeps `27 Minories, London EC3N 1DE`.
	GB: withSoftBreakBefore(
		addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${postcode}
${country}`,
		"postcode"
	),

	// %N%n%O%n%A%n%Z %C
	DE: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// %N%n%O%n%A%n%Z %C %S — Spain writes the number after a comma: `Calle Mayor, 12`.
	// Correos prints the province on its own line below the locality (`45012 TOLEDO` / `TOLEDO`).
	ES: addr`${attention}
${venue}
${numberLastCommaStreet}
${dependent_locality}
${postcode} ${locality}
${region}
${country}`,

	// %N%n%O%n%A%n%Z %C %S
	IT: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality} ${region}
${country}`,

	// India writes the number before a comma: `12, MG Road`.
	// India Post's UPU description prints the locality, the state and the PIN on lines
	// of their own (`Bangalore` / `Karnataka` / `560082`), where libaddressinput's
	// `%C %Z%n%S` puts the PIN before the state.
	IN: addr`${attention}
${venue}
${numberFirstCommaStreet}
${dependent_locality}
${locality}
${region}
${postcode}
${country}`,

	// %N%n%O%n%A%n%D%n%C %Z
	NZ: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality} ${postcode}
${country}`,

	// %O%n%N%n%A%n%C %S %Z, with the unit before the number as Australia Post prints it (`LEVEL 6 51 JACOBSON ST`).
	AU: addr`${venue}
${attention}
${unitFirstStreet}
${dependent_locality}
${locality} ${region} ${postcode}
${country}`,

	// 〒%Z%n%S%n%A%n%O%n%N, with the prefecture joined to the run below it: written on one line the
	// whole admin run is unseparated and only the postcode takes a space (`〒100-0005 東京都千代田区丸の内1-9-1`).
	JP: addr`${country}
${prefixedSlot("postcode", "〒")}
${region}${japaneseSubPrefecture}
${venue}
${attention}`,

	// %Z%n%S%C%D%n%A%n%O%n%N — the admin run prints without separators.
	// `LINE_JOINS.CN` sets that behavior.
	CN: addr`${country}
${postcode}
${region}${locality}${dependent_locality}
${chineseStreet}
${venue}
${attention}`,

	// %Z%n%S%C%n%A%n%O%n%N, with the whole address unseparated and largest first (`10044臺北市中正區忠孝西路一段120號1樓`).
	// Chunghwa Post's list and the GCIS register file the 鄉鎮市區 under its own column,
	// labeled `subregion`, where libaddressinput's `%C` reads `locality`.
	// A row labels one of the two.
	// The venue and recipient follow the address as JP and KR print them, set off by a
	// space on one line (`… 1樓 臺北北門郵局`) rather than glued to the 樓.
	TW: withSoftBreakBefore(
		withSoftBreakBefore(
			addr`${country}
${postcode}
${region}${subregion}${locality}${dependent_locality}
${hanStreet}
${venue}
${attention}`,
			"venue"
		),
		"attention"
	),

	// %S%n%C%n%A%n%O%n%N — this table holds one layout per country and Hong Kong writes
	// both orders, so it holds the Latin one (`21 Jordan Road, Yau Tsim Mong, Kowloon`),
	// which is what `isLargestFirstSystem("HK") === false` already asserts.
	// No postcode line: Hong Kong operates none.
	// Hongkong Post prints the flat and floor on a line above the building and street (`Flat 25, 12/F`).
	HK: addr`${attention}
${venue}
${unitLineNumberFirstStreet}
${dependent_locality}
${locality}
${region}
${country}`,
}

/**
 * Where a country writes the region when an address includes one and the postal layout prints none.
 *
 * Royal Mail and Deutsche Post need no county or Bundesland, so the GB and DE layouts above omit it.
 * Address writers may add the region.
 * A corpus row that labels it needs a position for it.
 *
 * Great Britain writes the county on its own line between the post town and the
 * postcode (`16 Holstein Street, Preston, Lancashire, PR1 1UN`).
 * Germany writes the Bundesland after the postcode and locality (`Hauptstraße 5, 01067 Dresden, Sachsen`).
 */
export const REGION_LINE_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
	GB: withSoftBreakBefore(
		addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${region}
${postcode}
${country}`,
		"postcode"
	),

	DE: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality}
${region}
${country}`,
}

/**
 * Returns a layout for `country` that prints the region, or `null` when the country has none.
 *
 * A country whose layout already prints the region answers that layout.
 * Otherwise {@linkcode REGION_LINE_LAYOUTS} answers.
 */
export function regionLayoutForCountry(countryCode: string | null, script?: AddressScript): AddressLayout | null {
	const layout = layoutForCountry(countryCode, script)

	if (layout && layoutPrintsTag(layout, "region")) return layout

	return REGION_LINE_LAYOUTS[countryCode?.trim().toUpperCase() ?? ""] ?? null
}

/**
 * Returns a copy of `layout` that prints the region on its own line after the line that prints
 * the locality, or `layout` itself when it already prints the region or prints no locality.
 *
 * A postal layout leaves the region out where the operator's examples don't print it,
 * as Argentina's leaves out the province.
 * Address writers in those countries still write it after the town
 * (`Juan José Paso 600, 6400 Trenque Lauquen, Buenos Aires`), so a corpus
 * renders this form beside the postal one.
 */
export function layoutWithRegionAfterLocality(layout: AddressLayout): AddressLayout {
	if (layoutPrintsTag(layout, "region")) return layout

	const at = layout.lines.findIndex((line) => printedTags({ lines: [line] }).includes("locality"))

	if (at === -1) return layout

	const shifted = [...(layout.softBreakBefore ?? [])].map((index) => (index > at ? index + 1 : index))

	return {
		lines: [...layout.lines.slice(0, at + 1), [SLOTS.region], ...layout.lines.slice(at + 1)],
		...(shifted.length ? { softBreakBefore: new Set(shifted) } : {}),
	}
}

/**
 * Whether writers in `countryCode` print a region its postal layout leaves out.
 *
 * It holds where libaddressinput's layout prints the region and the cited layout doesn't, as for
 * Argentina's province and Romania's county. libaddressinput records what address forms in use print.
 * It's no citation for a postal layout, and it is evidence that writers print the region.
 *
 * France's and Great Britain's print none there, so a region never enters their rows.
 */
export function writersPrintRegionBesideLayout(countryCode: string, script?: AddressScript): boolean {
	const generated = GENERATED_ADDRESS_LAYOUTS[countryCode.trim().toUpperCase()]
	const layout = layoutForCountry(countryCode, script)

	return Boolean(generated && layout && layoutPrintsTag(generated, "region") && !layoutPrintsTag(layout, "region"))
}

/**
 * An order a country's address writers use beside the postal layout {@linkcode layoutForCountry} answers.
 */
export interface WrittenLayout {
	readonly layout: AddressLayout
	/**
	 * The fraction of rendered rows a synthesizer gives this order.
	 *
	 * The postal layout keeps what a country's written layouts leave.
	 */
	readonly share: number
	/**
	 * The sources that show the order in use, and why the share is what it is.
	 */
	readonly basis: string
}

/**
 * Orders a country writes beside its postal layout.
 *
 * A synthesizer renders the mix a reader meets rather than the one order an input system asks for.
 * A corpus rendered only in the postal order teaches a model no other order,
 * and the model then misreads the written one.
 */
export const WRITTEN_LAYOUTS: Readonly<Record<string, readonly WrittenLayout[]>> = {
	IN: [
		{
			// `Bengaluru, Karnataka 560001`: the region before the PIN, as US addresses place a ZIP Code.
			layout: addr`${attention}
${venue}
${numberFirstCommaStreet}
${dependent_locality}
${locality}
${region} ${postcode}
${country}`,
			share: 0.5,
			basis:
				"libaddressinput's IN `fmt` (`%C %Z%n%S`) states the postal order, `Bengaluru 560001, Karnataka`. " +
				"Every IN gauntlet input that names a locality, a state and a PIN writes the state first " +
				"(7 of 7 in packages/mailwoman/tools/eval-harness/gauntlet/cases/in, such as " +
				"`12 MG Road, Indiranagar, Bengaluru, Karnataka 560038, India`). " +
				"Neither source measures how often each order occurs, so the two share the rows evenly.",
		},
	],
}

/**
 * Returns the written layout a uniform draw in `[0, 1)` selects for `country`.
 *
 * It returns `null` when the draw falls to the postal layout or the country records no written layout.
 * The draw is the caller's so a seeded synthesizer stays reproducible.
 */
export function writtenLayoutForCountry(countryCode: string | null, draw: number): AddressLayout | null {
	let cumulative = 0

	for (const written of WRITTEN_LAYOUTS[countryCode?.trim().toUpperCase() ?? ""] ?? []) {
		cumulative += written.share

		if (draw < cumulative) return written.layout
	}

	return null
}

/**
 * Address systems that print the largest unit first, derived from the layouts
 * rather than listed because the layout is the statement of print order.
 *
 * A caller composing its own order can read this value instead of deriving it again.
 * A gazetteer hierarchy string represents a query and belongs to this API.
 *
 * Of the 197 layouts, 122 omit both a region and a street.
 * They're absent here.
 * Callers treat them as small-first.
 */
export const LARGEST_FIRST_SYSTEMS: ReadonlySet<string> = new Set(
	// Spread in `layoutForCountry`'s precedence, so a UPU reading replaces the skeleton it overrides.
	Object.entries({ ...GENERATED_ADDRESS_LAYOUTS, ...UPU_PAS_ADDRESS_LAYOUTS, ...ADDRESS_LAYOUTS })
		.filter(([, layout]) => layoutPrintsLargestFirst(layout) === true)
		.map(([countryCode]) => countryCode)
)

/**
 * Returns the layout for `country`, or `null` when neither table has an entry.
 *
 * Hand-authored entries take precedence because tests check them against real addresses.
 * A UPU Postal Addressing Systems reading comes next: that table holds a country only
 * where libaddressinput states no `fmt`, omits the locality line the postal operator's
 * own examples print, or orders that line differently from every example.
 *
 * Of the 55 shipped records with no usable `fmt`, the 8 read from a SAFD and the 22
 * read from a UPU description have a layout, and the rest answer `null`.
 * A jurisdiction in `UNADDRESSED_JURISDICTIONS` answers `null` too.
 * Its description states it has no permanent population.
 */
export function layoutForCountry(countryCode: string | null, script?: AddressScript): AddressLayout | null {
	if (!countryCode) return null

	const code = countryCode.trim().toUpperCase()

	if (UNADDRESSED_JURISDICTIONS[code]) return null

	if (script === "latin") {
		const latin = latinLayoutFor(code)

		if (latin) return latin
	}

	const hand = ADDRESS_LAYOUTS[code]
	const local = GENERATED_LOCAL_ADDRESS_LAYOUTS[code]

	// A hand-authored entry states one order and may be stating either, so the two
	// print orders decide: agreeing means the board-checked entry is the local order
	// and wins, disagreeing means the `fmt`-derived skeleton is.
	if (script === "local" && hand && local && layoutPrintsLargestFirst(hand) !== layoutPrintsLargestFirst(local)) {
		return local
	}

	// A SAFD entry is last because it exists only where libaddressinput states `fmt: null`.
	// A SAFD entry read ahead of a generated skeleton would replace a stated order with a second reading.
	// A UPU description is read ahead of the skeleton because it is admitted only where the skeleton
	// leaves out a line the postal operator prints or orders it against every printed example.
	return hand ?? UPU_PAS_ADDRESS_LAYOUTS[code] ?? GENERATED_ADDRESS_LAYOUTS[code] ?? S42_ADDRESS_LAYOUTS[code] ?? null
}

/**
 * Returns the primary document behind the layout {@linkcode layoutForCountry} renders for
 * an uppercase `code` with no script chosen, or `null` when that layout lacks a citation.
 *
 * A UPU reading's record is its citation, and every other table's citation is in `LAYOUT_CITATIONS`.
 * A code with no rendered layout returns `null` too.
 *
 * With `script` set to `latin`, the citation is the one behind the country's separate
 * Latin-script layout, from `LATIN_LAYOUT_CITATIONS`.
 */
export function layoutCitationForCountry(code: string, script?: AddressScript): LayoutCitation | null {
	if (script === "latin" && latinLayoutFor(code)) return LATIN_LAYOUT_CITATIONS[code] ?? null

	const layout = layoutForCountry(code)

	if (!layout) return null

	if (layout === UPU_PAS_ADDRESS_LAYOUTS[code]) return UPU_PAS_LAYOUT_RECORDS[code] ?? null

	return LAYOUT_CITATIONS[code] ?? null
}

/**
 * Every jurisdiction with a rendered layout and no primary citation for it, sorted.
 *
 * The `debt` repository check pins the length of this list, so it can only fall.
 */
export function uncitedLayoutJurisdictions(): string[] {
	return addressSystemMembers()
		.filter((member) => member.script === "local" && !layoutCitationForCountry(member.country))
		.map((member) => member.country)
}

/**
 * Returns every source's statement about one convention claim for this country,
 * or `null` when the country has no layout to read.
 *
 * Each source that holds a layout for the country contributes one observation,
 * and an observation that contradicts the claim is kept beside one that supports it.
 * Whether they disagree is a fact about the jurisdiction: libaddressinput states
 * what an input system requires, the OpenCage templates state what a renderer needs,
 * and a board entry states what real addresses do.
 *
 * A jurisdiction in UPU's S42 template inventory contributes an `upu-s42` observation
 * whose stance is `unread`: an approved crosswalk of its address semantics exists,
 * and this repository hasn't retrieved it.
 * A jurisdiction outside that inventory contributes none.
 *
 * That states that no crosswalk exists, rather than that one went unread.
 *
 * A jurisdiction whose UPU Postal Addressing Systems description was retrieved
 * contributes an `upu-pas` observation read from its examples.
 * `national-postal-authority` contributes none yet.
 *
 * An absent observation reads as unexamined rather than as agreement.
 * {@linkcode ObservationStance.Silent} exists to separate the two.
 */
export function conventionClaimForCountry(
	claim: ConventionClaimID,
	countryCode: string | null | undefined
): ConventionClaim | null {
	if (!countryCode) return null

	const code = countryCode.trim().toUpperCase()

	const generated = GENERATED_ADDRESS_LAYOUTS[code]
	const latin = GENERATED_LATIN_ADDRESS_LAYOUTS[code]
	const local = GENERATED_LOCAL_ADDRESS_LAYOUTS[code]
	const hand = ADDRESS_LAYOUTS[code]

	// A jurisdiction whose libaddressinput record states `fmt: null` is in no rendering table.
	// Its SAFD is the one source that speaks for it.
	const s42 = S42_READ_LAYOUTS[code] ?? S42_ADDRESS_LAYOUTS[code]
	const pas = UPU_PAS_ADDRESS_LAYOUTS[code]

	if (!generated && !latin && !local && !hand && !s42 && !pas) return null

	const observations: ConventionObservation[] = []

	// libaddressinput settles which components print and in what order,
	// so its `fmt` answers a line-order claim.
	// Its `lfmt` is a second statement by the same source about the Latin order.
	// A hand-authored country appears in no rendering table, so its `fmt` comes from the skeleton table.
	// That table exists for this comparison rather than for printing.
	for (const [layout, readFrom] of [
		[local ?? generated ?? HAND_AUTHORED_FORMAT_SKELETONS[code], READ_FROM.generated],
		[latin, READ_FROM.latin],
	] as const) {
		if (!layout) continue

		observations.push(
			conventionObservation(
				ConventionSource.LibAddressInput,
				stanceFromLayout(claim, layout, printedTags(layout)),
				readFrom
			)
		)
	}

	// Whether a jurisdiction's order reverses with its script is a comparison between two layouts
	// of the same jurisdiction, so it is answered here rather than in `stanceFromLayout`,
	// which sees one. libaddressinput's `lfmt` is its statement of the Latin order and `fmt`
	// of the native one, so a jurisdiction carrying both states the proposition itself.
	// A jurisdiction with one layout contributes no observation, because one order
	// is no evidence that a second order exists.
	//
	// The comparison is pairwise.
	// The order changes when any two components both layouts print sit in opposite relative
	// order, and the Latin layout may move one component while keeping the rest.
	// Two layouts that share fewer than two components contribute no observation about relative order.
	if (claim === ConventionClaimID.OrderingReversesWithScript) {
		const native = local ?? generated

		if (native && latin) {
			const nativeTags = printedTags(native)
			const latinTags = printedTags(latin)
			const shared = nativeTags.filter((tag) => latinTags.includes(tag))

			if (new Set(shared).size > 1) {
				observations.push(
					conventionObservation(
						ConventionSource.LibAddressInput,
						reorderedPairs(nativeTags, latinTags).length ? ObservationStance.Supports : ObservationStance.Contradicts,
						READ_FROM.latin
					)
				)
			}
		}
	}

	// The street atom's order came from the OpenCage templates rather than from `fmt`,
	// so only a claim about the street line reads as that source's statement.
	if (claim === ConventionClaimID.HouseNumberPrecedesStreet) {
		const layout = hand ?? local ?? generated

		if (layout) {
			observations.push(
				conventionObservation(
					ConventionSource.OpenCageAddressFormatting,
					stanceFromLayout(claim, layout, printedTags(layout)),
					READ_FROM.street
				)
			)
		}
	}

	// A retrieved UPU description states the order its examples print.
	if (pas) {
		const record = UPU_PAS_LAYOUT_RECORDS[code]!

		observations.push(
			conventionObservation(
				ConventionSource.PostalAddressingSystems,
				stanceFromLayout(claim, pas, printedTags(pas)),
				`UPU Postal Addressing Systems description for ${code}, dated ${record.documentDate}, retrieved ${record.retrievedAt}`
			)
		)
	}

	if (hand) {
		observations.push(
			conventionObservation(
				ConventionSource.MailwomanBoard,
				stanceFromLayout(claim, hand, printedTags(hand)),
				READ_FROM.board
			)
		)
	}

	// A country in UPU's template inventory has an approved crosswalk of its address semantics.
	// A retrieved template states an order and therefore answers the claim.
	// `Unread` on the rest records that a document exists to go and read.
	// That separates these 72 from the jurisdictions with no crosswalk to read at all.
	const cohort = s42CohortForJurisdiction(code)

	if (cohort) {
		observations.push(
			s42
				? conventionObservation(
						ConventionSource.PostalStandardS42,
						stanceFromLayout(claim, s42, printedTags(s42)),
						`UPU Standardized Address Format Description for ${code}, cohort ${cohort}, retrieved 2026-09-30`
					)
				: conventionObservation(
						ConventionSource.PostalStandardS42,
						ObservationStance.Unread,
						`UPU S42 template for ${code}, cohort ${cohort}, not retrieved`
					)
		)
	}

	return { claim, jurisdiction: code, observations }
}

/**
 * How a system joins its admin units (prefecture, city, ward) when they share one line.
 *
 * An absent value means the system's line join.
 * Japan prints its whole admin run unseparated (`東京都千代田区`) while its lines take
 * a space, so the two joins differ there.
 */
export const ADMIN_RUN_JOINS: Readonly<Record<string, string>> = {
	JP: "",
}

/**
 * Returns the join between adjacent admin units on one line in the selected country and `script`.
 *
 * Like {@linkcode lineJoinForCountry}, a CJK join applies only to the local script.
 */
export function adminRunJoinForCountry(countryCode: string | null, script?: AddressScript): string {
	const lineJoin = lineJoinForCountry(countryCode, script)

	if (!countryCode || lineJoin === ", ") return lineJoin

	return ADMIN_RUN_JOINS[countryCode.trim().toUpperCase()] ?? lineJoin
}

/**
 * Returns the line join for single-line output in the selected country and `script`.
 *
 * CJK joins apply only to the local script.
 * A single script keeps line order and separator tied to one system.
 */
export function lineJoinForCountry(countryCode: string | null, script?: AddressScript): string {
	if (!countryCode) return ", "

	const code = countryCode.trim().toUpperCase()

	if ((script ?? defaultScriptForCountry(code)) === "latin") return ", "

	return LINE_JOINS[code] ?? ", "
}

/**
 * Slots that a system key leaves out.
 *
 * A recipient line, an organization name and a trailing country name appear in every system,
 * so they do not separate one address grammar from another.
 */
const SYSTEM_KEY_IGNORED_TAGS: ReadonlySet<ComponentTag> = new Set(["attention", "venue", "country"])

function systemKeyTokens(atom: AddressAtom): string[] {
	// A slot with fixed text, such as Puerto Rico's `PR`, prints the skeleton's literal, so it
	// counts like a connector and leaves the country's system id where the trainer assigned it.
	if (isSlot(atom)) return SYSTEM_KEY_IGNORED_TAGS.has(atom.tag) || atom.fallback ? [] : [atom.tag]

	if (isLayout(atom)) return atom.lines.flatMap((line) => line.flatMap(systemKeyTokens))

	if (isAlternation(atom)) {
		const alternatives = atom.alternatives
			.map((inner) => systemKeyTokens(inner).join(" "))
			.filter((alternative) => alternative.length > 0)

		return alternatives.length ? [`(${alternatives.join("|")})`] : []
	}

	return []
}

/**
 * Returns the order in which a layout prints its address components, as a space-separated key.
 *
 * Two layouts with the same key describe the same address grammar: the same components in the same order.
 * Line breaks and separators are left out, because the decoder reads one line in which either may be absent.
 * An alternation is written `(a b|c d)`.
 */
export function addressSystemKey(layout: AddressLayout): string {
	return systemKeyTokens(layout).join(" ")
}

/**
 * One country's address system in one script.
 */
export interface AddressSystemMember {
	country: string
	script: AddressScript
	key: string
}

/**
 * Returns the address system of every country that has a layout, once per script that has its own layout.
 *
 * A country's `local` entry is {@link layoutForCountry}'s answer with no script chosen.
 * A country gets a `latin` entry only when libaddressinput states a separate Latin-script layout for it.
 */
export function addressSystemMembers(): AddressSystemMember[] {
	const countries = new Set([
		...Object.keys(ADDRESS_LAYOUTS),
		...Object.keys(GENERATED_ADDRESS_LAYOUTS),
		...Object.keys(S42_ADDRESS_LAYOUTS),
		...Object.keys(UPU_PAS_ADDRESS_LAYOUTS),
	])

	const members: AddressSystemMember[] = []

	for (const code of [...countries].toSorted()) {
		const local = layoutForCountry(code)

		if (local) {
			members.push({ country: code, script: "local", key: addressSystemKey(local) })
		}

		const latin = latinLayoutFor(code)

		if (latin) {
			members.push({ country: code, script: "latin", key: addressSystemKey(latin) })
		}
	}

	return members
}

/**
 * Returns the script used by {@link layoutForCountry} when the caller doesn't choose one.
 *
 * It returns `local` except for Hong Kong.
 * Hong Kong's default layout follows the order from its Latin skeleton.
 */
export function defaultScriptForCountry(countryCode: string): AddressScript {
	const code = countryCode.trim().toUpperCase()
	const local = GENERATED_LOCAL_ADDRESS_LAYOUTS[code]
	const chosen = ADDRESS_LAYOUTS[code] ?? GENERATED_ADDRESS_LAYOUTS[code]

	if (!local || !chosen) return "local"

	return layoutPrintsLargestFirst(chosen) === layoutPrintsLargestFirst(local) ? "local" : "latin"
}
