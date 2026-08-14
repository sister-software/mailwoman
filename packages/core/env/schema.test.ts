/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A BLANK environment variable must mean the same as an absent one.
 *
 *   Shells, Docker and CI all produce empty strings where an operator believes they set nothing: `export FOO=`, an
 *   unset `${VAR}` interpolation, a compose key with no value. Any coerced-numeric schema turns that into `0`, and a
 *   `.positive()` or `.min()` then rejects it — so the process dies at IMPORT, before any application code runs, citing
 *   a variable nobody knowingly set.
 *
 *   These cases are cheap to assert and impossible to notice by reading the schema, since the failure lives in the
 *   interaction between `z.coerce` and a constraint rather than in either one.
 */

import { describe, expect, test } from "vitest"

import { PublicEnvSchema } from "./schema.ts"

/**
 * Every key whose schema coerces to a number. A string key tolerates a blank value by construction; these are the ones
 * where blank and absent can diverge.
 */
const COERCED_NUMERIC_KEYS = ["MAILWOMAN_INTRA_OP_THREADS", "MAILWOMAN_BATCH_MAX"] as const

describe("blank env values are treated as absent", () => {
	for (const key of COERCED_NUMERIC_KEYS) {
		test(`${key}="" parses rather than throwing`, () => {
			expect(() => PublicEnvSchema.parse({ [key]: "" })).not.toThrow()
		})

		test(`${key}="" resolves to the same value as omitting it`, () => {
			const blank = PublicEnvSchema.parse({ [key]: "" })
			const absent = PublicEnvSchema.parse({})

			expect(blank[key]).toEqual(absent[key])
		})

		test(`${key} still accepts a real value`, () => {
			expect(PublicEnvSchema.parse({ [key]: "3" })[key]).toBe(3)
		})

		test(`${key} still REJECTS a genuinely invalid value`, () => {
			// The blank exemption must not become a general tolerance: a caller who sets 0 or a word has made a
			// mistake worth surfacing, unlike one whose shell handed us "".
			expect(() => PublicEnvSchema.parse({ [key]: "0" })).toThrow(/expected/i)
			expect(() => PublicEnvSchema.parse({ [key]: "banana" })).toThrow(/expected/i)
		})
	}
})
