/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The premise-linkage input adapter interface (#1902), plus the ONE implementation this repository ships:
 *   a synthetic fixture whose addresses, coordinates and identifiers are invented.
 *
 *   The interface is an async iterable rather than an array because a controlled file is read under terms
 *   that usually forbid holding it whole, and because a run that streams can be stopped without ever
 *   having materialized the licensed rows. A provider's data populates ONE implementation of this
 *   interface; nothing downstream of it changes.
 *
 *   The controlled adapter is deliberately NOT written here. Its file format is the provider's, it is
 *   not known yet, and inventing one now would mean the first real file either fits a guess or forces
 *   a redesign of the thing that was supposed to be fixed in advance.
 *
 *   Everything below is synthetic. The identifiers sit in the same reserved 0-prefixed range
 *   `@mailwoman/core/resolver`'s fixture provider uses, which no real UPRN occupies; the addresses name
 *   a town that does not exist; the coordinates are round numbers in the sea of arbitrary. The one
 *   rule this file must keep is that the ROWS and the PROVIDER'S ANSWERS are derived from a single
 *   table — two hand-maintained lists that must agree drift the moment someone edits one of them.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import {
	type AuthoritativeProvider,
	type AuthoritativeQuery,
	type AuthoritativeResponse,
	AuthoritativeResponseStatus,
	createFixtureAuthoritativeProvider,
	fixtureExactMatch,
	type Resolver,
} from "@mailwoman/core/resolver"

import { type PremiseLinkageInputRow, PremiseLinkageInputShapeClass } from "#eval-harness/premise-linkage/schema"
import type { GeocodeClassifier, GeocodeDeps } from "#geocode/core"

/**
 * Where a run's rows come from. One method, asynchronous, licensed-data-neutral: the controlled implementation reads a
 * provider's file, this file's implementation reads a constant, and the runner cannot tell them apart.
 */
export interface PremiseLinkageAdapter {
	/**
	 * Stable adapter name for the run's provenance. Never a file path — a path to a controlled file is itself a
	 * disclosure.
	 */
	readonly name: string
	rows(): AsyncIterable<PremiseLinkageInputRow>
}

/**
 * The scheme every synthetic row grades against. Real UK premise linkage grades against UPRNs; the fixture uses the
 * same scheme name with invented identifiers so the grading path is the one a controlled run takes.
 */
const SYNTHETIC_SCHEME = "uprn"

/**
 * The one coordinate the synthetic resolver answers with, for every row — a town centroid standing in for the admin
 * tier the open arm reaches when it cannot place a premise.
 */
const SYNTHETIC_ADMIN_LAT = 51.5
const SYNTHETIC_ADMIN_LON = -0.1

/**
 * One synthetic case: the row the adapter yields, and the answer the synthetic provider gives for it. Both halves live
 * here so an edit to one is an edit to the other.
 */
interface SyntheticCase {
	row: PremiseLinkageInputRow
	/**
	 * Substring of the normalized query the provider keys on. Unique per case — the fixture answers with the FIRST rule
	 * that hits, so an overlapping key silently reassigns another case's answer.
	 */
	matchOn: string
	/**
	 * The provider's answer. Absent means no rule, which the #1901 fixture answers as a refusal.
	 */
	response?: AuthoritativeResponse
	/**
	 * Throw instead of answering — the transport-failure case. A thrown provider is not a refusal, and the harness has to
	 * be able to tell them apart on real data, so the fixture set carries one.
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
		// Committed to a premise, named the neighbour's identifier: the `wrong` case.
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
			// Carries truth coordinates the terms do not permit publishing: the row still grades on identity, and any
			// coordinate error computed for it is a defect the report writer must refuse.
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
		},
		matchOn: "hotel terrace",
		// Committed to a premise and named NO identifier in the graded scheme: ungradable, and never `wrong`.
		response: fixtureExactMatch({
			providerPlaceID: "synthetic-place-0008",
			objectIDs: undefined,
			latitude: 51.508,
			longitude: -0.108,
		}),
	},
]

/**
 * The synthetic fixture set — every outcome the harness can record, at least once, across the five shape classes.
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
 * The provider that answers {@link syntheticFixtureAdapter}'s rows, built on `@mailwoman/core/resolver`'s #1901 fixture
 * so the arm under test consumes the shipped reference implementation rather than a local mock.
 *
 * The one thing layered on top is the throwing case: `createFixtureAuthoritativeProvider` always answers, and a harness
 * that has never seen a transport failure cannot claim it keeps failures apart from refusals.
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
				// Logged before the throw so the record is every query the provider RECEIVED, not only the ones
				// it answered — a consult that failed is still a consult, and a log that omits it under-counts.
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
 * A pipeline that always resolves to one admin coordinate — the shape of the open arm's answer when it can name a town
 * and not a premise.
 *
 * Fixture-only, and deliberately so: a controlled run supplies real {@link GeocodeDeps} built from the shipped model and
 * gazetteer, and this exists so the synthetic self-check runs on a machine with neither. It is exported for the same
 * reason the #1901 fixture provider is — one reference stub the command and the tests share, rather than two that
 * drift.
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

	return { classifier, resolver, placeCountry: false }
}
