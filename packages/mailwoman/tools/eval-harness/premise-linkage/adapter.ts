/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Defines the premise-linkage input adapter and this repository's synthetic fixture implementation. The fixture's
 * addresses, coordinates and identifiers are invented.
 *
 * The interface is an async iterable because controlled-file terms can forbid holding the entire file in memory.
 * A stream lets a run stop before it materializes all licensed rows. The controlled adapter belongs with its
 * provider because its file format is provider-specific and remains unknown.
 *
 * Everything below is synthetic. The identifiers use the reserved 0-prefixed range from the
 * `@mailwoman/core/resolver` fixture provider. Real UPRNs do not use that range. This file derives rows and provider
 * answers from one table. Separate hand-maintained lists could drift after an edit.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import {
	type AuthoritativeProvider,
	type AuthoritativeQuery,
	type AuthoritativeResponse,
	AuthoritativeResponseStatus,
	type Resolver,
} from "@mailwoman/core/resolver"
import {
	createFixtureAuthoritativeProvider,
	fixtureExactMatch,
} from "@mailwoman/core/resolver/fixture-authoritative-provider"

import type { GeocodeClassifier } from "#geocode/classifier"
import type { GeocodeDeps } from "#geocode/core"
import { type PremiseLinkageInputRow, PremiseLinkageInputShapeClass } from "#tools/eval-harness/premise-linkage/schema"

/**
 * Where a run's rows come from.
 *
 * Exposes one asynchronous method that does not depend on licensed data.
 * The controlled implementation reads a provider file.
 *
 * This implementation reads a constant.
 * The runner uses either implementation through the same method.
 */
export interface PremiseLinkageAdapter {
	/**
	 * Stable adapter name for the run's provenance.
	 *
	 * Never a file path — a path to a controlled file is itself a disclosure.
	 */
	readonly name: string
	rows(): AsyncIterable<PremiseLinkageInputRow>
}

/**
 * The scheme every synthetic row grades against.
 *
 * Real UK premise linkage grades against UPRNs.
 * The fixture uses the same scheme name and invented identifiers so a controlled run
 * and the fixture follow the same grading path.
 */
const SYNTHETIC_SCHEME = "uprn"

/**
 * The one coordinate the synthetic resolver answers with, for every row: a town centroid
 * standing in for the admin tier the open arm reaches when it cannot place a premise.
 */
const SYNTHETIC_ADMIN_LAT = 51.5
const SYNTHETIC_ADMIN_LON = -0.1

/**
 * One synthetic case: the row the adapter yields and the answer the synthetic provider
 * gives for it, both here so an edit to one is an edit to the other.
 */
interface SyntheticCase {
	row: PremiseLinkageInputRow
	/**
	 * The normalized-query substring used as the provider key.
	 *
	 * Unique per case, because the fixture answers with the first rule that hits,
	 * so an overlapping key silently reassigns another case's answer.
	 */
	matchOn: string
	/**
	 * The provider's answer.
	 *
	 * When absent, the fixture answers with a refusal because no rule applies.
	 */
	response?: AuthoritativeResponse
	/**
	 * Makes the provider throw to simulate a transport failure.
	 *
	 * The harness must distinguish that failure from a refusal on real data.
	 */
	transportError?: boolean
}

function syntheticIdentifier(index: number): string {
	return `00000000000${index}`
}

const SYNTHETIC_CASES: readonly SyntheticCase[] = [
	{
		row: {
			input: "1 Alpha Terrace, Testtown TT1 1TT",
			expectedObjectID: { scheme: SYNTHETIC_SCHEME, id: syntheticIdentifier(1) },
			expectedLat: 51.501,
			expectedLon: -0.101,
			coordinatePublishable: true,
			inputShapeClass: PremiseLinkageInputShapeClass.Clean,
			hasUnit: false,
			hasPostcode: true,
			hasStreet: true,
			hasLocality: true,
			hasHistoricalAlias: false,
		},
		matchOn: "alpha terrace",
		response: fixtureExactMatch({
			providerPlaceID: "synthetic-place-0001",
			objectIDs: { [SYNTHETIC_SCHEME]: syntheticIdentifier(1) },
			latitude: 51.501,
			longitude: -0.101,
		}),
	},
	{
		row: {
			input: "2 Bravo Terrace, Testtown TT1 1TT",
			expectedObjectID: { scheme: SYNTHETIC_SCHEME, id: syntheticIdentifier(2) },
			expectedLat: 51.502,
			expectedLon: -0.102,
			coordinatePublishable: true,
			inputShapeClass: PremiseLinkageInputShapeClass.Clean,
			hasUnit: false,
			hasPostcode: true,
			hasStreet: true,
			hasLocality: true,
			hasHistoricalAlias: false,
		},
		matchOn: "bravo terrace",
		// Committed to a premise and supplied the neighbor's identifier: the `wrong` case.
		response: fixtureExactMatch({
			providerPlaceID: "synthetic-place-0902",
			objectIDs: { [SYNTHETIC_SCHEME]: syntheticIdentifier(9) },
			latitude: 51.502,
			longitude: -0.102,
		}),
	},
	{
		row: {
			input: "3 Charlie Terrrace, Testtown TT1 1TT",
			expectedObjectID: { scheme: SYNTHETIC_SCHEME, id: syntheticIdentifier(3) },
			expectedLat: 51.503,
			expectedLon: -0.103,
			// The fixture retains truth coordinates for grading on identity.
			// The terms forbid publishing them, so the report writer must refuse any computed coordinate error.
			coordinatePublishable: false,
			inputShapeClass: PremiseLinkageInputShapeClass.Misspelled,
			hasUnit: false,
			hasPostcode: true,
			hasStreet: true,
			hasLocality: true,
			hasHistoricalAlias: false,
		},
		matchOn: "charlie terrrace",
	},
	{
		row: {
			input: "Flat 4, Delta Terrace, Testtown TT1 1TT",
			expectedObjectID: { scheme: SYNTHETIC_SCHEME, id: syntheticIdentifier(4) },
			expectedLat: 51.504,
			expectedLon: -0.104,
			coordinatePublishable: true,
			inputShapeClass: PremiseLinkageInputShapeClass.MultiUnit,
			hasUnit: true,
			hasPostcode: true,
			hasStreet: true,
			hasLocality: true,
			hasHistoricalAlias: false,
		},
		matchOn: "delta terrace",
		response: {
			status: AuthoritativeResponseStatus.Ambiguous,
			matches: [
				fixtureExactMatch({
					providerPlaceID: "synthetic-place-0004",
					objectIDs: { [SYNTHETIC_SCHEME]: syntheticIdentifier(4) },
					latitude: 51.504,
					longitude: -0.104,
				}).matches[0]!,
				fixtureExactMatch({
					providerPlaceID: "synthetic-place-0014",
					objectIDs: { [SYNTHETIC_SCHEME]: "000000000014" },
					latitude: 51.504,
					longitude: -0.104,
					matchStatus: "approximate",
				}).matches[0]!,
			],
			attribution: "Synthetic fixture data — not derived from any licensed source",
			license: "fixture-terms-v1",
			retrievedAt: null,
			datasetVersion: "fixture-premise-linkage",
		},
	},
	{
		row: {
			input: "Testtown TT1 1TT, 5 Echo Terrace",
			expectedObjectID: { scheme: SYNTHETIC_SCHEME, id: syntheticIdentifier(5) },
			expectedLat: 51.505,
			expectedLon: -0.105,
			coordinatePublishable: true,
			inputShapeClass: PremiseLinkageInputShapeClass.Reordered,
			hasUnit: false,
			hasPostcode: true,
			hasStreet: true,
			hasLocality: true,
			hasHistoricalAlias: false,
		},
		matchOn: "echo terrace",
		response: fixtureExactMatch({
			providerPlaceID: "synthetic-place-0005",
			objectIDs: { [SYNTHETIC_SCHEME]: syntheticIdentifier(5) },
			latitude: 51.505,
			longitude: -0.105,
		}),
	},
	{
		row: {
			input: "6 Foxtrot Row, Testtown TT1 1TT",
			expectedObjectID: { scheme: SYNTHETIC_SCHEME, id: syntheticIdentifier(6) },
			expectedLat: 51.506,
			expectedLon: -0.106,
			coordinatePublishable: true,
			inputShapeClass: PremiseLinkageInputShapeClass.Historic,
			hasUnit: false,
			hasPostcode: true,
			hasStreet: true,
			hasLocality: true,
			hasHistoricalAlias: true,
		},
		matchOn: "foxtrot row",
		response: fixtureExactMatch({
			providerPlaceID: "synthetic-place-0006",
			objectIDs: { [SYNTHETIC_SCHEME]: syntheticIdentifier(6) },
			latitude: 51.506,
			longitude: -0.106,
		}),
	},
	{
		row: {
			input: "7 Golf Terrace, Testtown TT1 1TT",
			expectedObjectID: { scheme: SYNTHETIC_SCHEME, id: syntheticIdentifier(7) },
			coordinatePublishable: false,
			inputShapeClass: PremiseLinkageInputShapeClass.Clean,
			hasUnit: false,
			hasPostcode: true,
			hasStreet: true,
			hasLocality: true,
			hasHistoricalAlias: false,
			expectedLat: null,
			expectedLon: null,
		},
		matchOn: "golf terrace",
		transportError: true,
	},
	{
		row: {
			input: "8 Hotel Terrace, Testtown TT1 1TT",
			expectedObjectID: { scheme: SYNTHETIC_SCHEME, id: syntheticIdentifier(8) },
			coordinatePublishable: false,
			inputShapeClass: PremiseLinkageInputShapeClass.Clean,
			hasUnit: false,
			hasPostcode: true,
			hasStreet: true,
			hasLocality: true,
			hasHistoricalAlias: false,
			expectedLat: null,
			expectedLon: null,
		},
		matchOn: "hotel terrace",
		// The provider commits to a premise but supplies no identifier in the graded scheme.
		// The result is ungradable.
		// The harness leaves `wrong` unassigned.
		response: fixtureExactMatch({
			providerPlaceID: "synthetic-place-0008",
			objectIDs: undefined,
			latitude: 51.508,
			longitude: -0.108,
		}),
	},
]

/**
 * The synthetic fixture set: every result the harness can record, at least once,
 * across the five shape classes.
 */
export function syntheticFixtureAdapter(): PremiseLinkageAdapter {
	return {
		name: "synthetic-fixture",
		async *rows(): AsyncIterable<PremiseLinkageInputRow> {
			for (const entry of SYNTHETIC_CASES) {
				yield entry.row
			}
		},
	}
}

/**
 * The provider that answers {@link syntheticFixtureAdapter}'s rows, built on
 * `@mailwoman/core/resolver`'s fixture so the arm under test consumes the shipped
 * reference implementation rather than a local mock.
 *
 * Adds a throwing case because `createFixtureAuthoritativeProvider` always answers.
 * A harness must see a transport failure before it can show that failures and refusals remain distinct.
 */
export function syntheticFixtureProvider(options: { log?: AuthoritativeQuery[] } = {}): AuthoritativeProvider {
	const rules = SYNTHETIC_CASES.filter((entry) => entry.response !== undefined).map((entry) => ({
		matchOn: entry.matchOn,
		response: entry.response!,
	}))

	const fixture = createFixtureAuthoritativeProvider({ rules, log: options.log })

	const throwingKeys = SYNTHETIC_CASES.filter((entry) => entry.transportError === true).map((entry) => entry.matchOn)

	return {
		name: "synthetic-premise-fixture",
		async lookup(query: AuthoritativeQuery): Promise<AuthoritativeResponse> {
			const haystack = query.normalizedQuery.toLowerCase()

			if (throwingKeys.some((key) => haystack.includes(key))) {
				// Logged before the throw, so the record is every query the provider received
				// rather than only the ones it answered: a consult that failed is still a consult.
				options.log?.push(query)

				throw new Error("synthetic transport failure")
			}

			return fixture.lookup(query)
		},
	}
}

function syntheticNode(partial: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode {
	return { start: 0, end: 0, confidence: 1, children: [], ...partial }
}

/**
 * A pipeline that always resolves to one admin coordinate — the shape of the open
 * arm's answer when it can name a town and not a premise.
 *
 * Used only by fixtures.
 * Controlled runs supply real {@link GeocodeDeps} from the shipped model and gazetteer.
 *
 * This implementation lets the synthetic self-check run without either resource.
 * The command and tests share this exported reference stub, as they share the fixture provider.
 */
export function syntheticFixtureDeps(): GeocodeDeps {
	const classifier: GeocodeClassifier = {
		parse: async (text: string) => ({
			raw: text,
			roots: [
				syntheticNode({ tag: "locality", value: "Testtown" }),
				syntheticNode({ tag: "postcode", value: "TT1 1TT" }),
			],
		}),
	}

	const resolver: Resolver = {
		artifactCoverage: null,
		capabilityGaps: null,
		resolveTree: async (tree) => ({
			raw: tree.raw,
			roots: [
				syntheticNode({
					tag: "locality",
					value: "Testtown",
					lat: SYNTHETIC_ADMIN_LAT,
					lon: SYNTHETIC_ADMIN_LON,
					placeID: "wof:0",
					metadata: { resolver_name: "Testtown", resolver_country: "GB" },
				}),
				syntheticNode({ tag: "postcode", value: "TT1 1TT" }),
			],
		}),
	}

	return { classifier, resolver, placeCountry: "none" }
}
