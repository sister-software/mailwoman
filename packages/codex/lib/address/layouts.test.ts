/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What each source says about a country's addressing convention, disagreements included.
 *
 *   #2323 asks the layouts to cite UPU S42. No layout in this package reads from S42 or from a postal operator's
 *   own description, so neither source contributes an observation yet, and the tests below record that rather
 *   than let an absent source read as agreement. What the package does hold is libaddressinput's belief about
 *   what a user must supply, the OpenCage templates' belief about what a renderer needs, and a board entry's
 *   record of real addresses. Those disagree for some countries, and the disagreement is the finding.
 */

import { describe, expect, it } from "vitest"

import {
	ConventionClaimID,
	ConventionSource,
	KIND_BY_SOURCE,
	ObservationKind,
	ObservationStance,
	observationsDisagree,
} from "#address/convention-claims"
import { ADDRESS_LAYOUTS, conventionClaimForCountry, layoutForCountry } from "#address/layouts"
import { GENERATED_ADDRESS_LAYOUTS, GENERATED_LATIN_ADDRESS_LAYOUTS } from "#address/layouts/generated"

const CLAIMS = Object.values(ConventionClaimID)

describe("conventionClaimForCountry", () => {
	it("answers for exactly the countries that have a layout", () => {
		const codes = new Set([...Object.keys(GENERATED_ADDRESS_LAYOUTS), ...Object.keys(ADDRESS_LAYOUTS)])

		for (const code of codes) {
			expect(conventionClaimForCountry(ConventionClaimID.LargestUnitFirst, code), code).not.toBeNull()
		}

		expect(conventionClaimForCountry(ConventionClaimID.LargestUnitFirst, "ZZ")).toBeNull()
		expect(conventionClaimForCountry(ConventionClaimID.LargestUnitFirst, "")).toBeNull()
		expect(conventionClaimForCountry(ConventionClaimID.LargestUnitFirst, null)).toBeNull()
	})

	it("reads each observation's kind from its source", () => {
		for (const claim of CLAIMS) {
			for (const code of Object.keys(ADDRESS_LAYOUTS)) {
				for (const entry of conventionClaimForCountry(claim, code)!.observations) {
					expect(entry.kind, `${code}/${claim}/${entry.source}`).toBe(KIND_BY_SOURCE[entry.source])
					expect(entry.readFrom.length).toBeGreaterThan(0)
				}
			}
		}
	})

	it("cites the board for a locale this project publishes weights for", () => {
		const claim = conventionClaimForCountry(ConventionClaimID.PostcodePrecedesLocality, "FR")!

		expect(claim.jurisdiction).toBe("FR")
		expect(claim.observations.map((entry) => entry.source)).toContain(ConventionSource.MailwomanBoard)

		// France prints `%Z %C`, the postcode before the locality.
		expect(claim.observations.find((entry) => entry.source === ConventionSource.MailwomanBoard)!.stance).toBe(
			ObservationStance.Supports
		)
	})

	it("has no dataset observation to set against the board for nine of the twelve board locales", () => {
		// `GENERATED_ADDRESS_LAYOUTS` omits every hand-authored country, and the Latin
		// and local tables hold only the eight whose two scripts print different orders.
		// So for the nine board locales outside that eight, this package carries the
		// board's layout as the only statement, and the comparison most worth seeing
		// is the one that cannot be made. libaddressinput's `fmt` for those nine is in
		// `packages/core/data/chromium-i18n/ssl-address/` rather than in a table here,
		// which is why the observation is absent rather than contradicting.
		const unmatched = Object.keys(ADDRESS_LAYOUTS).filter((code) => {
			const claim = conventionClaimForCountry(ConventionClaimID.PostcodePrecedesLocality, code)!

			return !claim.observations.some((entry) => entry.source === ConventionSource.LibAddressInput)
		})

		expect(unmatched.toSorted()).toEqual(["AU", "DE", "ES", "FR", "GB", "IN", "IT", "NZ", "US"])
	})

	it("cites libaddressinput alone for a country with no board entry", () => {
		const code = Object.keys(GENERATED_ADDRESS_LAYOUTS).find((candidate) => !ADDRESS_LAYOUTS[candidate])!
		const claim = conventionClaimForCountry(ConventionClaimID.LargestUnitFirst, code)!

		expect(claim.observations.map((entry) => entry.source)).toEqual([ConventionSource.LibAddressInput])
		expect(claim.observations[0]!.kind).toBe(ObservationKind.Implementation)
	})

	it("cites the renderer only for the claim the renderer settled", () => {
		// The street atom's order came from the OpenCage templates.
		// The line order came from `fmt`.
		const street = conventionClaimForCountry(ConventionClaimID.HouseNumberPrecedesStreet, "US")!
		const lines = conventionClaimForCountry(ConventionClaimID.PostcodePrecedesLocality, "US")!

		expect(street.observations.map((entry) => entry.source)).toContain(ConventionSource.OpenCageAddressFormatting)

		expect(lines.observations.map((entry) => entry.source)).not.toContain(ConventionSource.OpenCageAddressFormatting)
	})

	it("claims no UPU observation, because none has been retrieved", () => {
		const codes = new Set([...Object.keys(GENERATED_ADDRESS_LAYOUTS), ...Object.keys(ADDRESS_LAYOUTS)])
		const upu = new Set<string>([ConventionSource.PostalOperator, ConventionSource.PostalStandardS42])
		const cited: string[] = []

		for (const claim of CLAIMS) {
			for (const code of codes) {
				for (const entry of conventionClaimForCountry(claim, code)!.observations) {
					if (upu.has(entry.source)) {
						cited.push(`${code}/${claim}/${entry.source}`)
					}
				}
			}
		}

		expect(cited).toEqual([])
	})

	it("keeps both sides where the dataset and the Latin order disagree", () => {
		// A country with a distinct `lfmt` gets two statements from libaddressinput, and they can differ.
		// Recording one would report agreement that the data does not show.
		const disagreeing: string[] = []

		for (const claim of CLAIMS) {
			for (const code of Object.keys(GENERATED_LATIN_ADDRESS_LAYOUTS)) {
				const answer = conventionClaimForCountry(claim, code)!

				const stances = new Set(
					answer.observations
						.filter((entry) => entry.source === ConventionSource.LibAddressInput)
						.map((entry) => entry.stance)
				)

				if (stances.size > 1) {
					disagreeing.push(`${code}/${claim}`)
				}
			}
		}

		// The set is non-empty for a real dataset: eight countries define a distinct pair.
		expect(disagreeing.length).toBeGreaterThan(0)
	})

	it("reports a disagreement rather than resolving it", () => {
		const found: string[] = []

		for (const claim of CLAIMS) {
			for (const code of Object.keys(ADDRESS_LAYOUTS)) {
				const answer = conventionClaimForCountry(claim, code)!

				if (observationsDisagree(answer)) {
					found.push(`${code}/${claim}`)
				}
			}
		}

		// Whatever the count, every disagreeing claim keeps every observation rather than dropping one.
		for (const key of found) {
			const [code, claim] = key.split("/") as [string, ConventionClaimID]
			const answer = conventionClaimForCountry(claim, code)!

			expect(answer.observations.some((entry) => entry.stance === ObservationStance.Supports)).toBe(true)
			expect(answer.observations.some((entry) => entry.stance === ObservationStance.Contradicts)).toBe(true)
			expect(layoutForCountry(code)).not.toBeNull()
		}
	})
})
