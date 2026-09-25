import { GeocodeOutcomeSchema } from "@mailwoman/api"
import type { GeocodeResult } from "mailwoman/geocode"
import { expect, test } from "vitest"
import { z } from "zod"

const KnownFieldsSchema = z.object(GeocodeOutcomeSchema.shape)

type Inferred = z.infer<typeof GeocodeOutcomeSchema>

type KnownInferred = z.infer<typeof KnownFieldsSchema>

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

type IsAssignable<A, B> = [A] extends [B] ? true : false

type Expect<T extends true> = T

export type _KeysMatch = Expect<Equal<keyof GeocodeResult, keyof KnownInferred>>

export type _SchemaAcceptsRealResult = Expect<IsAssignable<GeocodeResult, KnownInferred>>

export type _ResultAcceptsSchema = Expect<IsAssignable<Inferred, GeocodeResult>>

const GEOCODE_RESULT_FIELD_NAMES = {
	input: true,
	components: true,
	lat: true,
	lon: true,
	resolution_tier: true,
	epistemic_status: true,
	derivation: true,
	entity: true,
	uncertainty_m: true,
	locality: true,
	region: true,
	postcode: true,
	house_number: true,
	street: true,
	venue: true,
	dependent_locality: true,
	unit: true,
	countryCode: true,
	hierarchy: true,
	candidates: true,
	rooftop: true,
	postcode_country_scope: true,
	capital_promotion: true,
	variant_alias_exemption: true,
	intent_markers: true,
	admin_coherence: true,
	authoritative: true,
	dropped_components: true,
	unfollowed_components: true,
} satisfies Record<keyof GeocodeResult, true>

test("GeocodeOutcomeSchema field set matches GeocodeResult (runtime backstop — the compile-time pin above, via `yarn compile`, is the primary alarm; see file header)", () => {
	const schemaKeys = Object.keys(GeocodeOutcomeSchema.shape).toSorted()
	const resultKeys = Object.keys(GEOCODE_RESULT_FIELD_NAMES).toSorted()

	expect(schemaKeys).toEqual(resultKeys)
})
