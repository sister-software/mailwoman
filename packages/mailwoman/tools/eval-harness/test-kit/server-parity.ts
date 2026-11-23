// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The comparison behind each drop-in server's parity test: the server's own geocoder
 *   against a geocode session, over one sample of gauntlet inputs.
 *
 *   Each server builds its engine from a different entry point, so a test in the server's package
 *   hands its geocoder to {@linkcode serverParityDifferences} and asserts on the rows that come back.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import { sha256Hex } from "@mailwoman/core/hash"
import type { InputModeSelection } from "@mailwoman/core/pipeline"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"

import type { LayerContribution } from "#geocode/layers/contributions"
import { createDropInGeocodeSession } from "#geocode/session/drop-in"
import { loadRegressionCases } from "#tools/eval-harness/gauntlet/cases/load"
import type { SeedCase } from "#tools/eval-harness/gauntlet/cases/seed-case"

/**
 * The sample keeps a gauntlet case when this number divides the leading digits of its id digest.
 */
const SAMPLE_MODULUS = 13

/**
 * The count of leading hexadecimal digits of a case id's digest that decide whether the sample keeps it.
 */
const SAMPLE_DIGEST_DIGITS = 8

/**
 * The fields of a geocode result that two engines must agree on.
 */
export interface ParityAnswer {
	lat: number | null
	lon: number | null
	tier: string | null
	country: string | null
}

/**
 * One sampled input the server and the session answer differently.
 */
export interface ParityDifference {
	/**
	 * The gauntlet case's id.
	 */
	id: string
	input: string
	/**
	 * The country the gauntlet case states for the input.
	 */
	statedCountry: string
	server: ParityAnswer
	session: ParityAnswer
}

/**
 * A server's side of the comparison.
 */
export interface ServerParityOptions {
	/**
	 * Geocodes one input through the engine the server builds.
	 */
	server: (input: string) => Promise<GeocodeResult>
	/**
	 * The data layers the server composes.
	 * The session it is compared with composes the same ones.
	 */
	layers: readonly LayerContribution[]
	/**
	 * The input mode the server gives every request, absent when the server gives none.
	 */
	inputMode?: InputModeSelection
}

/**
 * The rows of one comparison.
 */
export interface ServerParityReport {
	/**
	 * Every sampled gauntlet case, in the gauntlet loader's order.
	 */
	sample: SeedCase[]
	/**
	 * The sampled cases the two engines answer differently, in the same order.
	 */
	differences: ParityDifference[]
}

/**
 * Whether the host holds the gazetteer both engines resolve against.
 */
export function serverParityDataPresent(): Promise<boolean> {
	return pathExists(wofDatabasePath("candidate.db"))
}

/**
 * Reads the parity sample: each gauntlet case whose id digest leaves a remainder of zero.
 *
 * A case's membership depends on its own id, so a case added to the gauntlet
 * leaves every other case's membership as it was.
 * The inputs keep the spelling the case files give them.
 */
export async function readServerParitySample(): Promise<SeedCase[]> {
	const cases = await loadRegressionCases()

	return cases.filter(({ id }) => {
		return Number.parseInt(sha256Hex(id).slice(0, SAMPLE_DIGEST_DIGITS), 16) % SAMPLE_MODULUS === 0
	})
}

function parityAnswerOf(result: GeocodeResult): ParityAnswer {
	return {
		lat: result.lat ?? null,
		lon: result.lon ?? null,
		tier: result.resolution_tier ?? null,
		country: result.countryCode ?? null,
	}
}

function sameAnswer(a: ParityAnswer, b: ParityAnswer): boolean {
	return a.lat === b.lat && a.lon === b.lon && a.tier === b.tier && a.country === b.country
}

/**
 * Geocodes the parity sample through a server and through a geocode session,
 * and returns the cases whose latitude, longitude, resolution tier or country differ.
 *
 * The session is the one a drop-in server builds over the server's own layers:
 * it parses under `en-US` and applies no country scope.
 * It takes the server's input mode.
 *
 * @throws When either engine throws on an input.
 */
export async function serverParityDifferences({
	server,
	layers,
	inputMode,
}: ServerParityOptions): Promise<ServerParityReport> {
	const sample = await readServerParitySample()

	await using session = await createDropInGeocodeSession(layers)

	const differences: ParityDifference[] = []

	for (const { id, input, country } of sample) {
		const serverAnswer = parityAnswerOf(await server(input))
		const sessionAnswer = parityAnswerOf((await session.geocode(input, inputMode ? { inputMode } : {})).result)

		if (!sameAnswer(serverAnswer, sessionAnswer)) {
			differences.push({ id, input, statedCountry: country, server: serverAnswer, session: sessionAnswer })
		}
	}

	return { sample, differences }
}
