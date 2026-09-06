/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { $public as corePublic } from "@mailwoman/core/env"
import { $public, PublicNeuralEnvSchema } from "@mailwoman/neural/env"
import { afterEach, describe, expect, test, vi } from "vitest"

afterEach(() => vi.unstubAllEnvs())

test("the neural view inherits live core settings and owns its own", () => {
	vi.stubEnv("MAILWOMAN_DATA_ROOT", "/tmp/neural-env-first")
	vi.stubEnv("MAILWOMAN_INTRA_OP_THREADS", "2")
	expect($public.MAILWOMAN_DATA_ROOT).toBe(corePublic.MAILWOMAN_DATA_ROOT)
	expect($public.MAILWOMAN_INTRA_OP_THREADS).toBe(2)
	expect(Object.keys(corePublic)).not.toContain("MAILWOMAN_INTRA_OP_THREADS")
	vi.stubEnv("MAILWOMAN_INTRA_OP_THREADS", "4")
	expect($public.MAILWOMAN_INTRA_OP_THREADS).toBe(4)
})

/**
 * A BLANK environment variable must mean the same as an absent one.
 *
 * Shells, Docker and CI all produce empty strings where an operator believes they set nothing: `export FOO=`, an unset
 * `${VAR}` interpolation, a compose key with no value. Any coerced-numeric schema turns that into `0`, and a
 * `.positive()` or `.min()` then rejects it — so the process dies at IMPORT, before any application code runs, citing a
 * variable nobody knowingly set. The failure lives in the interaction between `z.coerce` and a constraint rather than
 * in either one, so every coerced-numeric key gets these cases.
 */
const COERCED_NUMERIC_KEYS = ["MAILWOMAN_INTRA_OP_THREADS"] as const

describe("blank env values are treated as absent", () => {
	for (const key of COERCED_NUMERIC_KEYS) {
		test(`${key}="" parses rather than throwing`, () => {
			expect(() => PublicNeuralEnvSchema.parse({ [key]: "" })).not.toThrow()
		})

		test(`${key}="" resolves to the same value as omitting it`, () => {
			const blank = PublicNeuralEnvSchema.parse({ [key]: "" })
			const absent = PublicNeuralEnvSchema.parse({})

			expect(blank[key]).toEqual(absent[key])
		})

		test(`${key} still accepts a real value`, () => {
			expect(PublicNeuralEnvSchema.parse({ [key]: "3" })[key]).toBe(3)
		})

		test(`${key} still REJECTS a genuinely invalid value`, () => {
			// The blank exemption must not become a general tolerance: a caller who sets 0 or a word has made a
			// mistake worth surfacing, unlike one whose shell handed us "".
			expect(() => PublicNeuralEnvSchema.parse({ [key]: "0" })).toThrow(/expected/i)
			expect(() => PublicNeuralEnvSchema.parse({ [key]: "banana" })).toThrow(/expected/i)
		})
	}
})
