/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compile-time drift pin between `@mailwoman/api`'s `GeocodeOutcomeSchema` (hand-modeled from
 *   `GeocodeResult`'s wire shape, with NO import from `mailwoman` — `api/schema.ts`'s engine-agnosticism
 *   boundary) and the real `GeocodeResult` interface this package owns (`geocode-core.ts`). `mailwoman`
 *   is the one workspace allowed to import both sides, so the pin lives here.
 *
 *   THE ALARM IS A TYPE ERROR, NOT A RUNTIME ONE. vitest's esbuild transform strips types without
 *   checking them, so a plain `.test.ts` file gets zero protection from `yarn vitest run` alone — the
 *   type-level declarations below only mean anything under `tsc`. `mailwoman/tsconfig.json` normally
 *   excludes all of `./test/**` (vitest-only, not part of `tsc -b`); this ONE file is carved back in via
 *   an explicit `files` entry specifically so `yarn compile` type-checks it. The `test()` at the bottom
 *   is a secondary, genuinely-useful RUNTIME backstop (see its own comment) — not the primary alarm.
 *
 *   BIDIRECTIONAL, WITH A DOCUMENTED COMPROMISE (per the task brief: "if exact bidirectional
 *   assignability is impossible ... document the achievable direction(s) precisely"):
 *
 *   `GeocodeOutcomeSchema` is deliberately `.loose()` (forward-compat — an engine field the schema
 *   doesn't know about yet still rides through instead of being stripped). `.loose()` gives
 *   `z.infer<typeof GeocodeOutcomeSchema>` an implicit `{ [x: string]: unknown }` catchall, and
 *   TypeScript never treats a plain interface (`GeocodeResult`, no index signature) as assignable TO a
 *   type that has one — regardless of whether the named fields actually line up. Verified empirically
 *   (scratch `tsc` runs, not checked in): `type _x = IsAssignable<GeocodeResult, z.infer<typeof
 *   GeocodeOutcomeSchema>>` is `false` even when every field matches, purely because of the index
 *   signature — "Index signature for type 'string' is missing in type 'GeocodeResult'." So the LITERAL
 *   two-line form the brief sketches (`z.infer<typeof GeocodeOutcomeSchema> = {} as GeocodeResult` and
 *   back) is impossible for a `.loose()` schema in one of the two directions. Below is the closest
 *   equivalent that still catches every real class of drift:
 *
 *   - **Direction 2 — schema-too-wide (overpromises to generated clients), literal form:**
 *     `IsAssignable<Inferred, GeocodeResult>`. If the schema claims a field, or a wider/looser type for
 *     a field, than `GeocodeResult` actually guarantees, this fails to compile — a generated client would
 *     otherwise trust a promise the real engine can violate. Also incidentally catches a field the schema
 *     DROPPED (a dropped field vanishes from `Inferred` too, so assigning into `GeocodeResult` — which
 *     still requires it — fails the same way).
 *   - **Direction 1 — schema-too-narrow (would reject/misdescribe real results), narrowed to declared
 *     fields:** the index signature blocks the literal form, so this checks against `KnownFieldsSchema`
 *     — the SAME shape (`GeocodeOutcomeSchema.shape`, read live off the real export, never hand-copied)
 *     rebuilt WITHOUT `.loose()`'s catchall (`z.object(shape)` defaults to strip mode). That recovers
 *     real per-field type checking (a field typed narrower or outright wrong vs. `GeocodeResult` fails to
 *     compile) but, on its own, cannot see a field entirely ABSENT from the schema — an object missing an
 *     extra property is still structurally assignable to a target that doesn't require it. `_KeysMatch`
 *     closes that specific gap: an exact compile-time key-SET equality between `keyof GeocodeResult` and
 *     the schema's declared keys, so an added/removed/renamed field fails to compile even though the
 *     per-field value check alone would miss it.
 *
 *   Empirically verified each check fires independently: dropping a schema field breaks `_KeysMatch` AND
 *   Direction 2; narrowing one field's type (e.g. `lat` non-nullable) breaks Direction 1 only; adding a
 *   schema field `GeocodeResult` doesn't have breaks `_KeysMatch` AND Direction 2.
 *
 *   `vitest`'s own `expectTypeOf`/`assertType` were deliberately NOT used — they only gain teeth under
 *   `vitest --typecheck` (a mode this repo doesn't run; its default `typecheck.include` is `*.test-d.ts`
 *   anyway, not this file's required `.test.ts` name), so they'd silently no-op under the repo's actual
 *   `yarn vitest run`. The hand-rolled `Equal`/`IsAssignable` utilities below are pure type-level
 *   conditional types with zero runtime footprint and zero new dependencies, wired to fire under the
 *   thing this repo actually runs: `yarn compile`.
 */

import { GeocodeOutcomeSchema } from "@mailwoman/api"
import { expect, test } from "vitest"
import { z } from "zod"

import type { GeocodeResult } from "../geocode-core.ts"

/** The schema's declared shape, rebuilt as a non-`.loose()` object — same fields, no catchall index signature. */
const KnownFieldsSchema = z.object(GeocodeOutcomeSchema.shape)

type Inferred = z.infer<typeof GeocodeOutcomeSchema>
type KnownInferred = z.infer<typeof KnownFieldsSchema>

/** True iff `A` and `B` are exactly the same type (the standard distributive-conditional identity trick). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
/** True iff `A` is structurally assignable to `B` (wrapped in a tuple so a union `A` doesn't distribute). */
type IsAssignable<A, B> = [A] extends [B] ? true : false
/** Forces a compile error when its argument isn't literally `true` — the "assertion" for the checks below. */
type Expect<T extends true> = T

// Exact key-set parity — see file header. Fails to compile on any field added, removed, or renamed on
// EITHER side (GeocodeResult or GeocodeOutcomeSchema).
export type _KeysMatch = Expect<Equal<keyof GeocodeResult, keyof KnownInferred>>

// Direction 1 — schema-too-narrow guard, narrowed to the schema's declared fields (see file header for
// why the literal `.loose()` form is impossible). A real GeocodeResult must satisfy every field the
// schema claims to describe.
export type _SchemaAcceptsRealResult = Expect<IsAssignable<GeocodeResult, KnownInferred>>

// Direction 2 — schema-too-wide guard, literal form. The schema must never promise more than a real
// GeocodeResult actually guarantees.
export type _ResultAcceptsSchema = Expect<IsAssignable<Inferred, GeocodeResult>>

/**
 * Every `GeocodeResult` field name, as a `satisfies` object — TypeScript itself enforces this list can't drift from the
 * interface (add, remove, or rename a `GeocodeResult` field and this stops compiling). Exists so the runtime check
 * below has something concrete to compare against; JS has no reflection over a TS interface, so SOME hardcoded list is
 * unavoidable for a runtime assertion — this is the compile-time-guarded version of one.
 */
const GEOCODE_RESULT_FIELD_NAMES = {
	input: true,
	lat: true,
	lon: true,
	resolution_tier: true,
	uncertainty_m: true,
	locality: true,
	region: true,
	postcode: true,
	house_number: true,
	street: true,
	countryCode: true,
	hierarchy: true,
	candidates: true,
} satisfies Record<keyof GeocodeResult, true>

test("GeocodeOutcomeSchema field set matches GeocodeResult (runtime backstop — the compile-time pin above, via `yarn compile`, is the primary alarm; see file header)", () => {
	// This is deliberately independent of the type-level `_KeysMatch` above: it inspects the REAL,
	// already-constructed `GeocodeOutcomeSchema.shape` at runtime, so it also fires under plain `yarn
	// vitest run` (no `tsc` required) — a second, cheaper signal for the same class of drift the
	// compile-time pin exists to catch.
	const schemaKeys = Object.keys(GeocodeOutcomeSchema.shape).sort()
	const resultKeys = Object.keys(GEOCODE_RESULT_FIELD_NAMES).sort()

	expect(schemaKeys).toEqual(resultKeys)
})
