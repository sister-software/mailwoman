/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { $private as corePrivate, $public as corePublic } from "@mailwoman/core/env"
import { $public as resolverPublic } from "@mailwoman/resolver-wof-sqlite/env"
import { $private, $public, PublicMailwomanEnvSchema } from "mailwoman/env"
import { afterEach, describe, expect, test, vi } from "vitest"

afterEach(() => vi.unstubAllEnvs())

test("the CLI view inherits live core and resolver settings", () => {
	vi.stubEnv("MAILWOMAN_DATA_ROOT", "/tmp/mailwoman-env-first")
	vi.stubEnv("MAILWOMAN_WOF_DB", "/tmp/wof-first.db")
	expect($public.MAILWOMAN_DATA_ROOT).toBe(corePublic.MAILWOMAN_DATA_ROOT)
	expect($public.MAILWOMAN_WOF_DB).toBe(resolverPublic.MAILWOMAN_WOF_DB)
	vi.stubEnv("MAILWOMAN_DATA_ROOT", "/tmp/mailwoman-env-second")
	vi.stubEnv("MAILWOMAN_WOF_DB", "/tmp/wof-second.db")
	expect($public.MAILWOMAN_DATA_ROOT).toBe("/tmp/mailwoman-env-second")
	expect($public.MAILWOMAN_WOF_DB).toBe("/tmp/wof-second.db")
})

test("CLI settings follow environment changes through the package entry point", () => {
	vi.stubEnv("MAILWOMAN_DIAG_INTERP", "1")
	expect($public.MAILWOMAN_DIAG_INTERP).toBe("1")
	vi.stubEnv("MAILWOMAN_DIAG_INTERP", "0")
	expect($public.MAILWOMAN_DIAG_INTERP).toBe("0")
	vi.stubEnv("MAILWOMAN_BATCH_MAX", "7")
	expect($public.MAILWOMAN_BATCH_MAX).toBe(7)
})

test("CLI secrets stay private and package-owned", () => {
	vi.stubEnv("MAILWOMAN_PREMISE_LINKAGE_SALT", "test-salt")
	expect($private.MAILWOMAN_PREMISE_LINKAGE_SALT).toBe("test-salt")
	expect(Object.keys($public)).not.toContain("MAILWOMAN_PREMISE_LINKAGE_SALT")
	expect(Object.keys(corePrivate)).not.toContain("MAILWOMAN_PREMISE_LINKAGE_SALT")
	expect(Object.keys(corePublic)).not.toContain("MAILWOMAN_DIAG_INTERP")
	expect(Object.keys(resolverPublic)).not.toContain("MAILWOMAN_DIAG_INTERP")
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
const COERCED_NUMERIC_KEYS = ["MAILWOMAN_BATCH_MAX"] as const

describe("blank env values are treated as absent", () => {
	for (const key of COERCED_NUMERIC_KEYS) {
		test(`${key}="" parses rather than throwing`, () => {
			expect(() => PublicMailwomanEnvSchema.parse({ [key]: "" })).not.toThrow()
		})

		test(`${key}="" resolves to the same value as omitting it`, () => {
			const blank = PublicMailwomanEnvSchema.parse({ [key]: "" })
			const absent = PublicMailwomanEnvSchema.parse({})

			expect(blank[key]).toEqual(absent[key])
		})

		test(`${key} still accepts a real value`, () => {
			expect(PublicMailwomanEnvSchema.parse({ [key]: "3" })[key]).toBe(3)
		})

		test(`${key} still REJECTS a genuinely invalid value`, () => {
			// The blank exemption must not become a general tolerance: a caller who sets 0 or a word has made a
			// mistake worth surfacing, unlike one whose shell handed us "".
			expect(() => PublicMailwomanEnvSchema.parse({ [key]: "0" })).toThrow(/expected/i)
			expect(() => PublicMailwomanEnvSchema.parse({ [key]: "banana" })).toThrow(/expected/i)
		})
	}
})
