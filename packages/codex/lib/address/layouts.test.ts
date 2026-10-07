/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What each source states about a country's addressing convention, disagreements included.
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
import {
	GENERATED_ADDRESS_LAYOUTS,
	GENERATED_LATIN_ADDRESS_LAYOUTS,
	HAND_AUTHORED_FORMAT_SKELETONS,
} from "#address/layouts/generated"
import { S42_ADDRESS_LAYOUTS, S42_READ_LAYOUTS } from "#address/layouts/s42"
import { s42CohortForJurisdiction } from "#address/s42-templates"

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

	it("sets a dataset observation against the board for every board locale", () => {
		// The rendering tables stay disjoint, so a hand-authored country appears in none of them
		// and for a while no dataset statement could be read for the twelve locales that matter most.
		// `HAND_AUTHORED_FORMAT_SKELETONS` holds their `fmt` skeleton for this comparison only,
		// so every board locale holds both statements and any disagreement is visible.
		const unmatched = Object.keys(ADDRESS_LAYOUTS).filter((code) => {
			const claim = conventionClaimForCountry(ConventionClaimID.PostcodePrecedesLocality, code)!

			return !claim.observations.some((entry) => entry.source === ConventionSource.LibAddressInput)
		})

		expect(unmatched).toEqual([])

		for (const code of Object.keys(ADDRESS_LAYOUTS)) {
			const sources = conventionClaimForCountry(ConventionClaimID.PostcodePrecedesLocality, code)!.observations.map(
				(entry) => entry.source
			)

			expect(sources, code).toContain(ConventionSource.MailwomanBoard)
			expect(sources, code).toContain(ConventionSource.LibAddressInput)
		}
	})

	it("keeps the skeleton table out of the rendering path", () => {
		// `layoutForCountry` must keep answering the board's layout for a board locale.
		// A skeleton that reached rendering would replace a layout checked against
		// real addresses with one derived from a dataset.
		for (const code of Object.keys(HAND_AUTHORED_FORMAT_SKELETONS)) {
			expect(layoutForCountry(code), code).toBe(ADDRESS_LAYOUTS[code])
		}
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

	it("reads a retrieved S42 template and marks the rest unread", () => {
		// The stance separates three states a single boolean would merge.
		// A template this repository has read can be set against the other sources.
		// A template this repository has not read stays unread.
		// A jurisdiction outside the inventory has no such document at all.
		const codes = [...new Set([...Object.keys(GENERATED_ADDRESS_LAYOUTS), ...Object.keys(ADDRESS_LAYOUTS)])]

		for (const code of codes) {
			const observations = conventionClaimForCountry(ConventionClaimID.PostcodePrecedesLocality, code)!.observations
			const s42 = observations.find((entry) => entry.source === ConventionSource.PostalStandardS42)

			if (!s42CohortForJurisdiction(code)) {
				expect(s42, code).toBeUndefined()

				continue
			}

			expect(s42, code).toBeDefined()
			expect(s42!.kind, code).toBe(ObservationKind.ApprovedCrosswalk)

			if (S42_READ_LAYOUTS[code] || S42_ADDRESS_LAYOUTS[code]) {
				expect(s42!.stance, code).not.toBe(ObservationStance.Unread)
				expect(s42!.readFrom, code).toMatch(/retrieved/u)
			} else {
				expect(s42!.stance, code).toBe(ObservationStance.Unread)
			}
		}
	})

	it("reads no statement from a national postal authority or from the UPU compendium yet", () => {
		const codes = new Set([...Object.keys(GENERATED_ADDRESS_LAYOUTS), ...Object.keys(ADDRESS_LAYOUTS)])

		const unread = new Set<string>([ConventionSource.NationalPostalAuthority, ConventionSource.PostalAddressingSystems])

		const cited: string[] = []

		for (const claim of CLAIMS) {
			for (const code of codes) {
				for (const entry of conventionClaimForCountry(claim, code)!.observations) {
					if (unread.has(entry.source)) {
						cited.push(`${code}/${claim}/${entry.source}`)
					}
				}
			}
		}

		expect(cited).toEqual([])
	})

	it("keeps both sides where the dataset and the Latin order disagree", () => {
		// A country with a distinct `lfmt` gets two statements from libaddressinput, and they can differ.
		// A single recorded statement would report agreement that the data does not show.
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
