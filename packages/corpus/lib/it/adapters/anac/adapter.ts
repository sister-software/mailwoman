/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `it-anac`: the OCDS release Autorità Nazionale Anticorruzione publishes for Italy's National
 * Database of Public Contracts, read for the addresses of the public bodies named on each contract.
 *
 * Input is the publisher's own JSON Lines: one OCDS release per line, as
 * `https://data.open-contracting.org/en/publication/117/download?name=<year>.jsonl.gz` serves it
 * once decompressed. A release carries a `parties` array, and each party holds a `roles` list, a
 * `name`, an `identifier` and an `address` whose four fields are `locality`, `postalCode`,
 * `countryName` and `streetAddress`. The adapter streams the file through `JSONSpliterator`, so a
 * year's release never sits in memory whole. `opts.inputPath` is one `.jsonl` edition or a directory
 * holding several, which is what `fetchITANAC` writes.
 *
 * ## Which roles the adapter reads, and why those two
 *
 * The register's `addressRoles` for `it-procurement-grants-1` names exactly two fields,
 * `parties[roles=buyer].address` and `parties[roles=payer].address`.
 * Those two are the only address fields the release carries. Measured over the whole 2025 edition, 9,405 releases and
 * 29,823 party objects in three roles: a `supplier` party holds no `address` key at all on 11,075 of
 * 11,075, a `buyer` holds one on 9,381 of 9,381, and a `payer` on 9,359 of 9,367. So every address
 * in this release belongs to a contracting authority or to the office that pays.
 * Both of those are Italian public entities, and a contracting counterparty holds none.
 *
 * That is what makes this source admissible under the policy that a corpus carries the addresses of
 * organizations and no address of an identifiable natural person. The two admitted roles are held by
 * public bodies, and the one role whose parties can be sole traders publishes no address.
 * {@linkcode readANACParty} still applies a name check and refuses a party whose name takes the
 * `Surname, Firstname` form, because a later edition could carry one. On the 2025 edition the check
 * refuses no party: 0 of the 18,740 address-bearing buyer and payer parties take that form, while 56
 * hold a comma inside an organization name — `PARCO NAZIONALE DEL CILENTO, VALLO DI DIANO E
 * ALBURNI` and `SETTORE PATRIMONIO, AMBIENTE E LAVORI PUBBLICI` among them — which is why the check
 * requires a single word on each side of the comma rather than a comma alone.
 *
 * ## The street line
 *
 * Italy writes the house number after the street name and joins the two with a space, which is what
 * `STREET_ORDERS` records as `number-last` and what `COMMA_JOINED_STREET_COUNTRIES` records by
 * leaving `IT` out. {@linkcode splitTrailingStreetLine} performs the split. Three Italian
 * conventions are normalized before it runs, each measured over the 2025 edition's 11,930
 * non-placeholder street lines:
 *
 * 1. **A trailing copy of the locality.** 406 lines end with the value the publisher writes in its
 *    own `locality` field — `CORSO ITALIA, 29 FIRENZE` against `locality` `FIRENZE`. The copy is
 *    removed only where it equals that field, so the publisher's own record is what authorizes the
 *    removal rather than a place-name list.
 * 2. **A civic marker.** 1,222 lines write `numero civico` as a marker before the number, spaced as
 *    `PIAZZA ROOSEVELT N 1` or glued as `VIA ROMA N.68`. The marker is dropped, so the street is
 *    `PIAZZA ROOSEVELT` rather than `PIAZZA ROOSEVELT N`.
 * 3. **`senza numero`.** 182 lines end `SNC` or `SN`, which states that the premise has no civic
 *    number, so the tail is dropped and no `house_number` is composed from it.
 *
 * A kilometre point is not a house number. `S.S. 7 APPIA KM 671` names a point on a state highway,
 * so a number preceded by `KM` is left in the street line, which then refuses the row under the rule
 * below.
 *
 * **A street line holding a digit the split could not place refuses the row.**
 * {@linkcode ANACRefusal.StreetNumberUnplaced} covers 194 of those 11,930 lines, where the publisher
 * appends a qualifier after the number: `VIA CIRCONVALLAZIONE, 1 PARCO IDROSCALO`, `VIA FELTRE 57
 * 32100 BELLUNO (BL)`, `VIA SAN SECONDO 29 BIS`. Emitting them would label a civic number as part of
 * a street name. A line with no digit at all is emitted as a street with no number, which is the
 * ordinary `PIAZZA CASTELLO` case and 1,416 of the 11,930. The remaining 10,320 carry a number.
 *
 * Two limits of the split are the publisher's own ambiguity rather than this reader's. `PIAZZA
 * UMBERTO 1` is Umberto I's square and reads identically to civic number 1, and the release gives no
 * field that separates them. A number written twice, as `CORSO ITALIA 55 55` and `VIALE DEI PIANETI 1
 * 1`, leaves the first copy in the street name. Together with Italy's date-named streets — `VIA 4
 * NOVEMBRE`, `PIAZZA 1 MAGGIO`, `VIA 2 AGOSTO 1980` — 93 of the 10,320 numbered lines keep a digit
 * inside the street, and most of those digits belong to the street's name.
 *
 * ## What the split was checked against
 *
 * The release publishes no preformatted address line, so no field of the publisher's states the
 * written form this adapter composes. The check available is reversibility against the publisher's
 * own string: the composed `street` and `house_number`, rejoined, reproduce the published
 * `streetAddress` on 11,736 of the 11,736 street lines this adapter emits, after the three
 * normalizations above and folding case, inner whitespace and the comma. Against the published
 * string as published, 10,027 of 11,736 reproduce it exactly under the same folding, and each of the
 * 1,709 that do not differs by one of those three normalizations. The split therefore loses no
 * published token. Which side of the split each token belongs on is the part no field of this
 * publisher's confirms.
 *
 * Every other component is a published value copied unchanged, which the same pass checked: 0 of the
 * 18,473 rows the 2025 edition admits carry a `locality`, `postcode` or `venue` that differs from the
 * field it came from.
 *
 * ## Placeholders and the postcode
 *
 * The publisher writes the literal `N.A.` where it holds no value: 476 postcodes, 6 localities and 6
 * street lines on the 2025 edition. {@linkcode isPlaceholderValue} treats it as absent, so no row
 * carries `N.A.` as a postcode.
 *
 * An Italian CAP is five digits. A postcode that is neither a placeholder nor five digits is not a
 * CAP, and the row is refused rather than stripped of the field: the one such value on the 2025
 * edition is `01238-000`, a São Paulo CEP on the payer `ISTITUTO ITALIANO DI CULTURA DI SAN PAOLO`,
 * whose address is in Brazil rather than Italy. A `countryName` naming any country but Italy refuses
 * the row for the same reason. Buyers write `ITALY` on all 9,381 rows and payers write no
 * `countryName` at all.
 *
 * ## Identity and licence
 *
 * The row id is content-addressed over the aligned components. The publisher's party identifier
 * cannot serve: a buyer's `IT-CF` fiscal code carries more than one address on 17 of 3,119 distinct
 * codes, and one address recurs across hundreds of releases, so the identifier identifies the
 * organization rather than the address.
 *
 * The OCP Data Registry publishes this release under CC BY 4.0, which the address-source register
 * elected on 2026-09-30 with `spdx` `CC-BY-4.0`. CC BY requires credit, a link to the licence and a
 * statement that changes were made, so every row records the licence and
 * {@linkcode IT_ANAC_ATTRIBUTION} is the credit the model card carries.
 *
 * The adapter honors `opts.limit`, `opts.signal` and `opts.country`.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { splitTrailingStreetLine } from "#adapters/street-line"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const IT_ANAC_ADAPTER_ID = "it-anac"

/**
 * The one jurisdiction this adapter emits.
 *
 * ANAC's release covers Italian public contracting, so the set has one member.
 */
export const IT_ANAC_COUNTRIES: readonly string[] = ["IT"]

/**
 * The licence the address-source register elected for this publication.
 *
 * The OCP Data Registry's publication page for id 117 states Creative Commons Attribution
 * 4.0 International, and the register records it under `spdx` as `CC-BY-4.0`.
 */
export const IT_ANAC_LICENSE = "CC-BY-4.0"

/**
 * The credit CC BY 4.0 obliges, which the model card carries beside the licence
 * and a statement that the data was changed.
 */
export const IT_ANAC_ATTRIBUTION = "Autorità Nazionale Anticorruzione (ANAC), via the OCP Data Registry"

/**
 * The two party roles the adapter reads.
 *
 * The register's `addressRoles` names these two fields and no other, because the
 * `supplier` role — the one role whose parties are contracting counterparties
 * rather than public bodies — publishes no `address` object.
 */
export const IT_ANAC_PARTY_ROLES: readonly string[] = ["buyer", "payer"]

/**
 * Why a party's address did not become a row.
 *
 * The reading returns one of these rather than an empty result, so a caller counting
 * refusals knows which condition each party met.
 * `tools/dev-tools` and the adapter's test both count them.
 */
export const ANACRefusal = {
	/**
	 * The party holds a role other than `buyer` or `payer`, so its address is out
	 * of scope even where it carries one.
	 */
	RoleNotAdmitted: "role-not-admitted",
	/**
	 * The party carries no `address` object, or every field in it is empty or a placeholder.
	 */
	AddressAbsent: "address-absent",
	/**
	 * The address states no locality, so nothing places it.
	 */
	LocalityAbsent: "locality-absent",
	/**
	 * The street line holds a digit that the split could not read as a house number.
	 */
	StreetNumberUnplaced: "street-number-unplaced",
	/**
	 * The postcode is neither absent nor a five-digit Italian CAP.
	 */
	PostcodeNotCAP: "postcode-not-cap",
	/**
	 * `countryName` names a country other than Italy.
	 */
	CountryNotItaly: "country-not-italy",
	/**
	 * The party name takes the `Surname, Firstname` form a natural person's name takes.
	 */
	NamePersonalForm: "name-personal-form",
	/**
	 * The components the party yielded do not render as an Italian address line.
	 */
	Unrenderable: "unrenderable",
	/**
	 * The rendered line carries one component, so it is a place name rather than an address.
	 *
	 * A party whose name holds no letter, whose postcode is the publisher's placeholder
	 * and whose street line is absent leaves the locality alone.
	 */
	ComponentsTooFew: "components-too-few",
} as const

/**
 * One of the {@link ANACRefusal} reasons.
 */
export type ANACRefusal = (typeof ANACRefusal)[keyof typeof ANACRefusal]

/**
 * What one party yielded: a row, or the reason it yielded none.
 */
export type ANACPartyReading = { readonly admitted: CanonicalRow } | { readonly refused: ANACRefusal }

/**
 * The OCDS address object, carrying the four fields this release populates.
 */
export interface ANACAddress {
	locality?: string | null
	postalCode?: string | null
	countryName?: string | null
	streetAddress?: string | null
}

/**
 * One `parties` member of a release.
 */
export interface ANACParty {
	name?: string | null
	roles?: readonly string[] | null
	address?: ANACAddress | null
}

/**
 * One line of the input: an OCDS release.
 *
 * The adapter reads `parties` alone.
 * A release also carries `tender`, `awards` and `contracts`, and no address
 * sits on any of them in this publication.
 */
export interface ANACRelease {
	ocid?: string
	parties?: readonly ANACParty[] | null
}

/**
 * The value the publisher writes where it holds none.
 *
 * It is `N.A.` with the dots as published, and the comparison folds case and inner whitespace
 * because the same placeholder reaches three different fields.
 */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set(["na", "n.a.", "n/a", "nd", "n.d."])

/**
 * An Italian CAP: five digits, leading zeroes included, as `02100` for Rieti.
 */
const CAP = /^\d{5}$/u

/**
 * The country names this release writes for Italy.
 *
 * Buyers write `ITALY` on every row of the 2025 edition.
 * The other two spellings are accepted because a later edition translating the
 * field would otherwise refuse every row.
 */
const ITALIAN_COUNTRY_NAMES: ReadonlySet<string> = new Set(["italy", "italia", "it", "ita"])

/**
 * `numero civico` written as a marker in front of the number.
 *
 * The marker must start its own token, which is what keeps the final `N` of `VIA THOMAS ALVA EDISON
 * 10/D` out of the match, and it must be followed by a digit, so a street whose name ends in one of
 * these words is untouched.
 */
const CIVIC_MARKER = /(?<=^|[\s,])(?:n|nr|num|civ|civico)\s*\.?\s*(?=\d)/giu

/**
 * `senza numero` or `senza numero civico`, the publisher's statement that the premise has no number.
 */
const SENZA_NUMERO = /[\s,]+(?:snc|sn)\.?$/iu

/**
 * A number introduced by a kilometre marker, which points at a place on a highway
 * rather than at a premise on a street.
 */
const KILOMETRE_POINT = /[\s,]+km\.?[\s,]*\d+(?:[.,]\d+)?$/iu

/**
 * A name of the form `Surname, Firstname`: one comma, one word on each side, letters only.
 *
 * An organization name in this release holds a comma often and holds a word on each side of it rarely:
 * `PARCO NAZIONALE DEL CILENTO, VALLO DI DIANO E ALBURNI` has eight words after the comma.
 * The single word on each side is what the inverted personal form has
 * and what a department or authority name does not.
 */
const PERSONAL_NAME_FORM = /^\p{L}[\p{L}'’.-]*\s*,\s*\p{L}[\p{L}'’.-]*$/u

/**
 * Whether a published value is the publisher's placeholder for an absent one,
 * or holds no letter and no digit at all.
 *
 * A placeholder read at face value would reach a corpus as a postcode spelled `N.A.`.
 */
export function isPlaceholderValue(value: string): boolean {
	const trimmed = value.trim()

	if (!trimmed) return true

	if (!/[\p{L}\d]/u.test(trimmed)) return true

	return PLACEHOLDER_VALUES.has(trimmed.replaceAll(/\s+/gu, "").toLowerCase())
}

/**
 * A published field's value, or an empty string where the publisher states none.
 */
function fieldValue(value: string | null | undefined): string {
	const trimmed = (value ?? "").trim()

	return isPlaceholderValue(trimmed) ? "" : trimmed.replaceAll(/\s+/gu, " ")
}

/**
 * The street line with the three Italian conventions normalized away: a trailing copy
 * of the locality, a civic marker before the number, and a `senza numero` tail.
 *
 * `locality` is the publisher's own value for this party, which is what
 * authorizes removing the trailing copy.
 * Passing an empty string removes nothing.
 */
export function normalizeANACStreetLine(line: string, locality: string): string {
	let work = line.replaceAll(/\s+/gu, " ").trim()
	const folded = work.toUpperCase()
	const foldedLocality = locality.replaceAll(/\s+/gu, " ").trim().toUpperCase()

	if (foldedLocality && folded !== foldedLocality && folded.endsWith(` ${foldedLocality}`)) {
		work = work.slice(0, work.length - foldedLocality.length).replace(/[\s,.-]+$/u, "")
	}

	return work.replaceAll(CIVIC_MARKER, "").replace(SENZA_NUMERO, "").replaceAll(/\s+/gu, " ").trim()
}

/**
 * Read one party's address into a row, or report why it yielded none.
 *
 * Exported because the refusal reasons are the measurement this adapter is checked by: a caller reading
 * a whole edition counts them per reason rather than observing a row count it cannot account for.
 */
export function readANACParty(party: ANACParty): ANACPartyReading {
	const roles = party.roles ?? []

	if (roles.length !== 1 || !IT_ANAC_PARTY_ROLES.includes(roles[0]!)) {
		return { refused: ANACRefusal.RoleNotAdmitted }
	}

	const address = party.address

	if (!address) return { refused: ANACRefusal.AddressAbsent }

	const name = (party.name ?? "").trim()

	if (PERSONAL_NAME_FORM.test(name)) return { refused: ANACRefusal.NamePersonalForm }

	const countryName = fieldValue(address.countryName)

	if (countryName && !ITALIAN_COUNTRY_NAMES.has(countryName.toLowerCase())) {
		return { refused: ANACRefusal.CountryNotItaly }
	}

	const postcode = fieldValue(address.postalCode)

	if (postcode && !CAP.test(postcode)) return { refused: ANACRefusal.PostcodeNotCAP }

	const locality = fieldValue(address.locality)
	const streetLine = fieldValue(address.streetAddress)

	if (!locality && !postcode && !streetLine) return { refused: ANACRefusal.AddressAbsent }

	if (!locality) return { refused: ANACRefusal.LocalityAbsent }

	const components: CanonicalRow["components"] = {}

	// The party name is the organization at this address.
	// A name holding no letter is one of the fiscal codes and digit strings the OCP registry
	// records as erroneous organization names, and it reaches no row as a venue.
	if (name && /\p{L}/u.test(name)) {
		components.venue = name
	}

	if (streetLine) {
		const normalized = normalizeANACStreetLine(streetLine, locality)
		// A kilometre point is read as part of the line, so the split below leaves its digits in the
		// street and the row is refused rather than carrying a highway marker as a house number.
		const split = KILOMETRE_POINT.test(normalized) ? { street: normalized } : splitTrailingStreetLine(normalized)

		if (split) {
			if (!split.house_number && /\d/u.test(split.street)) {
				return { refused: ANACRefusal.StreetNumberUnplaced }
			}

			if (split.house_number) {
				components.house_number = split.house_number
			}

			components.street = split.street
		}
	}

	if (postcode) {
		components.postcode = postcode
	}

	components.locality = locality

	const rendered = formatAddressRow(components, "IT", { singleLine: true })

	if (!rendered) return { refused: ANACRefusal.Unrenderable }

	const { raw, components: aligned } = rendered

	if (Object.keys(aligned).length < 2) return { refused: ANACRefusal.ComponentsTooFew }

	return {
		admitted: {
			raw,
			components: aligned,
			country: "IT",
			locale: "it-IT",
			source: IT_ANAC_ADAPTER_ID,
			source_id: stableSourceID(IT_ANAC_ADAPTER_ID, aligned),
			corpus_version: "",
			license: IT_ANAC_LICENSE,
		},
	}
}

export function createITANACAdapter(): CorpusAdapter {
	return {
		id: IT_ANAC_ADAPTER_ID,
		defaultLicense: IT_ANAC_LICENSE,
		addressRole: AddressRole.Facility,
		register: SourceRegister.ANACContracts,
		surface: SurfaceOrigin.Rendered,
		description:
			"ANAC's OCDS contracts release (Italy): the addresses of the contracting authority and the paying office.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !IT_ANAC_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(IT_ANAC_ADAPTER_ID, IT_ANAC_COUNTRIES, opts.country)
			}

			let emitted = 0

			for (const editionPath of await anacEditionPaths(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				for await (const release of JSONSpliterator.fromAsync<ANACRelease>(editionPath)) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					for (const party of release.parties ?? []) {
						if (opts.limit !== undefined && emitted >= opts.limit) break

						const reading = readANACParty(party)

						if (!("admitted" in reading)) continue

						yield reading.admitted

						emitted++
					}
				}
			}
		},
	}
}

/**
 * Every edition under `inputPath`, which is one `.jsonl` or a directory holding them.
 *
 * The registry serves one file per year beside an all-time `full.jsonl.gz`,
 * and `fetchITANAC` writes whichever editions a caller asked for into one directory,
 * so a build reading several years points at that directory.
 * The editions are read in sorted order, which puts the years in chronological order and `full` after them.
 *
 * A directory holding no edition raises rather than yielding zero rows, so a wrong path
 * reports itself instead of reading as a publisher with no contracts.
 */
async function anacEditionPaths(inputPath: PathBuilderLike): Promise<readonly PathBuilderLike[]> {
	const path = PathBuilder.from(inputPath)

	if (path.basename().toLowerCase().endsWith(".jsonl")) return [path]

	const names = await Globerator.from("*.jsonl", { cwd: path.toString(), absolute: false }).toSorted()

	if (!names.length) {
		throw new Error(`${IT_ANAC_ADAPTER_ID} adapter: ${path.toString()} holds no .jsonl edition`)
	}

	return names.map((name) => path(name))
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const itANACAdapter = createITANACAdapter()
