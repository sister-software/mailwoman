/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-country layout table lists entries in print order. Readers can check a country by inspecting an address
 *   shape instead of tracing nested calls.
 *
 *   The line skeletons come from libaddressinput, Google's address metadata. This repository ships the data at
 *   `packages/core/data/chromium-i18n/ssl-address/` (252 countries, Apache-2.0). Its `fmt` field is the print order.
 *   This repository supplies the `%A` expansion into its street tags, the line-join policy, the country line and the
 *   post-office box.
 */

import {
	ConventionClaimID,
	conventionObservation,
	ConventionSource,
	ObservationStance,
	stanceFromLayout,
	type ConventionClaim,
	type ConventionObservation,
	reorderedPairs,
} from "#address/convention-claims"
import {
	addr,
	type AddressAtom,
	type AddressLayout,
	isAlternation,
	isLayout,
	isSlot,
	numberFirstCommaStreet,
	numberFirstStreet,
	numberLastCommaStreet,
	numberLastStreet,
	SLOTS,
	withSoftBreakBefore,
} from "#address/layout"
import {
	GENERATED_ADDRESS_LAYOUTS,
	GENERATED_LATIN_ADDRESS_LAYOUTS,
	GENERATED_LOCAL_ADDRESS_LAYOUTS,
	HAND_AUTHORED_FORMAT_SKELETONS,
} from "#address/layouts/generated"
import { S42_ADDRESS_LAYOUTS, S42_READ_LAYOUTS } from "#address/layouts/s42"
import { s42CohortForJurisdiction } from "#address/s42-templates"
import type { ComponentTag } from "#component"

export {
	GENERATED_ADDRESS_LAYOUTS,
	GENERATED_LATIN_ADDRESS_LAYOUTS,
	GENERATED_LOCAL_ADDRESS_LAYOUTS,
} from "#address/layouts/generated"

export { S42_ADDRESS_LAYOUTS, S42_LAYOUT_RECORDS, S42_READ_LAYOUTS, type S42LayoutRecord } from "#address/layouts/s42"

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
 * Whether the country selected by `countryCode` prints the largest unit first, in `script`.
 *
 * Every country carrying a distinct Latin order writes it smallest-first,
 * read off the layout rather than encoded as a rule.
 */
export function isLargestFirstSystem(countryCode: string | null, script?: AddressScript): boolean {
	if (!countryCode) return false

	const code = countryCode.trim().toUpperCase()

	if (script === "latin") {
		const latin = GENERATED_LATIN_ADDRESS_LAYOUTS[code]

		if (latin) return layoutPrintsLargestFirst(latin) === true
	}

	return LARGEST_FIRST_SYSTEMS.has(code)
}

/**
 * Which order a layout actually prints: `true` when its `region` line precedes its
 * street line, or `null` when the layout names no region or no street.
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

	// %O%n%N%n%A%n%Z %C
	FR: addr`${venue}
${attention}
${numberFirstStreet}
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
	ES: addr`${attention}
${venue}
${numberLastCommaStreet}
${dependent_locality}
${postcode} ${locality} ${region}
${country}`,

	// %N%n%O%n%A%n%Z %C %S
	IT: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality} ${region}
${country}`,

	// %N%n%O%n%A%n%C %Z%n%S — India writes the number before a comma: `12, MG Road`.
	IN: addr`${attention}
${venue}
${numberFirstCommaStreet}
${dependent_locality}
${locality} ${postcode}
${region}
${country}`,

	// %N%n%O%n%A%n%D%n%C %Z
	NZ: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality} ${postcode}
${country}`,

	// %O%n%N%n%A%n%C %S %Z
	AU: addr`${venue}
${attention}
${numberFirstStreet}
${dependent_locality}
${locality} ${region} ${postcode}
${country}`,

	// 〒%Z%n%S%n%A%n%O%n%N, with the prefecture joined to the run below it: written on one line the whole
	// admin run is unseparated and only the postal code takes a space (`〒100-0005 東京都千代田区丸の内1-9-1`).
	JP: addr`${country}
〒${postcode}
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

	// %S%n%C%n%A%n%O%n%N — this table holds one layout per country and Hong Kong writes
	// both orders, so it holds the Latin one (`21 Jordan Road, Yau Tsim Mong, Kowloon`),
	// which is what `isLargestFirstSystem("HK") === false` already asserts.
	// No postcode line: Hong Kong operates none.
	HK: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${region}
${country}`,
}

/**
 * Address systems that print the largest unit first, derived from the layouts
 * rather than listed because the layout is the statement of print order.
 *
 * A caller composing its own order can read this value instead of deriving it again.
 * A gazetteer hierarchy string represents a query and belongs to this API.
 *
 * Of the 197 layouts, 122 omit both a region and a street.
 * They are absent here.
 * Callers treat them as small-first.
 */
export const LARGEST_FIRST_SYSTEMS: ReadonlySet<string> = new Set(
	Object.entries({ ...GENERATED_ADDRESS_LAYOUTS, ...ADDRESS_LAYOUTS })
		.filter(([, layout]) => layoutPrintsLargestFirst(layout) === true)
		.map(([countryCode]) => countryCode)
)

/**
 * Returns the layout for `country`, or `null` when neither table has an entry.
 *
 * Hand-authored entries take precedence because tests check them against real addresses.
 * `null` is the result for 55 of the 252 shipped records with no usable `fmt`.
 */
export function layoutForCountry(countryCode: string | null, script?: AddressScript): AddressLayout | null {
	if (!countryCode) return null

	const code = countryCode.trim().toUpperCase()

	if (script === "latin") {
		const latin = GENERATED_LATIN_ADDRESS_LAYOUTS[code]

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
	return hand ?? GENERATED_ADDRESS_LAYOUTS[code] ?? S42_ADDRESS_LAYOUTS[code] ?? null
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
 * and this repository has not retrieved it.
 * A jurisdiction outside that inventory contributes none.
 *
 * That states that no crosswalk exists, rather than that one went unread.
 *
 * `national-postal-authority` and `upu-pas` contribute no observation for any jurisdiction yet.
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

	if (!generated && !latin && !local && !hand && !s42) return null

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
	if (isSlot(atom)) return SYSTEM_KEY_IGNORED_TAGS.has(atom.tag) ? [] : [atom.tag]

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
	])

	const members: AddressSystemMember[] = []

	for (const code of [...countries].toSorted()) {
		const local = layoutForCountry(code)

		if (local) {
			members.push({ country: code, script: "local", key: addressSystemKey(local) })
		}

		const latin = GENERATED_LATIN_ADDRESS_LAYOUTS[code]

		if (latin) {
			members.push({ country: code, script: "latin", key: addressSystemKey(latin) })
		}
	}

	return members
}

/**
 * Returns the script used by {@link layoutForCountry} when the caller does not choose one.
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
