/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { liveEnv } from "@mailwoman/core/env"
import { blankAsAbsent } from "@mailwoman/core/env/utils"
import { afterEach, expect, expectTypeOf, test, vi } from "vitest"
import { z } from "zod"

afterEach(() => vi.unstubAllEnvs())

test("unchanged reads reuse validation; changed and deleted values invalidate it", () => {
	const validate = vi.fn(() => true)
	const env = liveEnv(z.object({ MW_TEST_CACHE: z.string().default("fallback").refine(validate) }))
	vi.stubEnv("MW_TEST_CACHE", undefined)
	expect(validate).not.toHaveBeenCalled()
	expect(env.MW_TEST_CACHE).toBe("fallback")
	expect(env.MW_TEST_CACHE).toBe("fallback")
	expect(validate).toHaveBeenCalledTimes(1)
	vi.stubEnv("MW_TEST_CACHE", "set")
	expect(env.MW_TEST_CACHE).toBe("set")
	expect(env.MW_TEST_CACHE).toBe("set")
	expect(validate).toHaveBeenCalledTimes(2)
	vi.stubEnv("MW_TEST_CACHE", undefined)
	expect(env.MW_TEST_CACHE).toBe("fallback")
	expect(validate).toHaveBeenCalledTimes(3)
})

test("undefined results and empty strings are cached without conflating their inputs", () => {
	const validate = vi.fn((value: unknown) => value)
	const env = liveEnv(z.object({ MW_TEST_OPTIONAL: z.preprocess(validate, z.string().optional()) }))
	vi.stubEnv("MW_TEST_OPTIONAL", undefined)
	expect(env.MW_TEST_OPTIONAL).toBeUndefined()
	expect(env.MW_TEST_OPTIONAL).toBeUndefined()
	expect(validate).toHaveBeenCalledTimes(1)
	vi.stubEnv("MW_TEST_OPTIONAL", "")
	expect(env.MW_TEST_OPTIONAL).toBe("")
	expect(env.MW_TEST_OPTIONAL).toBe("")
	expect(validate).toHaveBeenCalledTimes(2)
})

test("invalid values stay invalid on cached reads and recover after correction", () => {
	const validate = vi.fn((value: unknown) => value)
	const env = liveEnv(z.object({ MW_TEST_NUMBER: z.preprocess(validate, z.coerce.number().positive()) }))
	vi.stubEnv("MW_TEST_NUMBER", "bad")

	for (let i = 0; i < 2; i++) {
		expect(() => env.MW_TEST_NUMBER).toThrow(z.ZodError)
	}

	expect(validate).toHaveBeenCalledTimes(1)

	try {
		void env.MW_TEST_NUMBER
	} catch (error) {
		expect(error).toBeInstanceOf(z.ZodError)
		expect((error as z.ZodError).issues[0]?.path).toEqual(["MW_TEST_NUMBER"])
	}

	vi.stubEnv("MW_TEST_NUMBER", "3")
	expect(env.MW_TEST_NUMBER).toBe(3)
	expect(validate).toHaveBeenCalledTimes(2)
	vi.stubEnv("MW_TEST_NUMBER", "bad")
	expect(() => env.MW_TEST_NUMBER).toThrow(z.ZodError)
	expect(validate).toHaveBeenCalledTimes(3)
})

test("reading one field neither validates nor invalidates another field", () => {
	const validate = vi.fn(() => true)

	const env = liveEnv(
		z.object({
			MW_TEST_VALID: z.string().refine(validate),
			MW_TEST_INVALID: z.coerce.number().positive(),
		})
	)

	vi.stubEnv("MW_TEST_VALID", "ok")
	vi.stubEnv("MW_TEST_INVALID", "bad")
	expect(env.MW_TEST_VALID).toBe("ok")
	expect(() => env.MW_TEST_INVALID).toThrow(z.ZodError)
	vi.stubEnv("MW_TEST_INVALID", "2")
	expect(env.MW_TEST_VALID).toBe("ok")
	expect(validate).toHaveBeenCalledTimes(1)
	expect(env.MW_TEST_INVALID).toBe(2)
})

test("derived views preserve types, enumerable getters, and the base cache", () => {
	const validate = vi.fn(() => true)
	const base = liveEnv(z.object({ MW_TEST_BASE: z.coerce.number().refine(validate) }))
	const derived = liveEnv(z.object({ MW_TEST_LOCAL: z.string().default("local") }), base)
	expectTypeOf<typeof derived.MW_TEST_BASE>().toEqualTypeOf<number>()
	expectTypeOf<typeof derived.MW_TEST_LOCAL>().toEqualTypeOf<string>()
	expect(validate).not.toHaveBeenCalled()
	expect(Object.keys(derived)).toEqual(["MW_TEST_BASE", "MW_TEST_LOCAL"])

	expect(Object.getOwnPropertyDescriptor(derived, "MW_TEST_BASE")?.get).toBe(
		Object.getOwnPropertyDescriptor(base, "MW_TEST_BASE")?.get
	)

	vi.stubEnv("MW_TEST_BASE", "1")
	expect(base.MW_TEST_BASE).toBe(1)
	expect(derived.MW_TEST_BASE).toBe(1)
	expect(validate).toHaveBeenCalledTimes(1)
	vi.stubEnv("MW_TEST_BASE", "2")
	expect(derived.MW_TEST_BASE).toBe(2)
	expect(base.MW_TEST_BASE).toBe(2)
	expect(validate).toHaveBeenCalledTimes(2)
	expect(Object.keys(base)).not.toContain("MW_TEST_LOCAL")
})

test("inherited keys cannot be silently replaced", () => {
	const base = liveEnv(z.object({ MW_TEST_DUPLICATE: z.string() }))

	expect(() => liveEnv(z.object({ MW_TEST_DUPLICATE: z.number() }), base)).toThrow(
		"Environment field already inherited: MW_TEST_DUPLICATE"
	)
})

test("blank numeric values retain their defaults", () => {
	const env = liveEnv(z.object({ MW_TEST_BLANK: blankAsAbsent(z.coerce.number().positive().default(10)) }))
	vi.stubEnv("MW_TEST_BLANK", "")
	expect(env.MW_TEST_BLANK).toBe(10)
	vi.stubEnv("MW_TEST_BLANK", "4")
	expect(env.MW_TEST_BLANK).toBe(4)
	vi.stubEnv("MW_TEST_BLANK", undefined)
	expect(env.MW_TEST_BLANK).toBe(10)
})

test("object-level refinements are rejected rather than silently skipped", () => {
	const schema = z.object({ MW_TEST_REFINED: z.string() }).refine(() => false)
	expect(() => liveEnv(schema)).toThrow("cannot be used on object schemas containing refinements")
})
