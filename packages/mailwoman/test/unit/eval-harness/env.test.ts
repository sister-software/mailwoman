/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { $private as corePrivate, $public as corePublic } from "@mailwoman/core/env"
import { $private, $public } from "mailwoman/env"
import { afterEach, expect, test, vi } from "vitest"

afterEach(() => vi.unstubAllEnvs())

test("evaluation views inherit live core settings and credentials", () => {
	vi.stubEnv("MAILWOMAN_BATCH_MAX", "7")
	vi.stubEnv("HF_TOKEN", "test-token")
	expect($public.MAILWOMAN_BATCH_MAX).toBe(corePublic.MAILWOMAN_BATCH_MAX)
	expect($private.HF_TOKEN).toBe(corePrivate.HF_TOKEN)
	expect(Object.keys($public)).not.toContain("HF_TOKEN")
	vi.stubEnv("MAILWOMAN_BATCH_MAX", "8")
	expect($public.MAILWOMAN_BATCH_MAX).toBe(8)
})

test("evaluation settings follow environment changes through the package entry point", () => {
	vi.stubEnv("MAILWOMAN_DIAG_INTERP", "1")
	expect($public.MAILWOMAN_DIAG_INTERP).toBe("1")
	vi.stubEnv("MAILWOMAN_DIAG_INTERP", "0")
	expect($public.MAILWOMAN_DIAG_INTERP).toBe("0")
})

test("the premise-linkage salt stays private and package-owned", () => {
	vi.stubEnv("MAILWOMAN_PREMISE_LINKAGE_SALT", "test-salt")
	expect($private.MAILWOMAN_PREMISE_LINKAGE_SALT).toBe("test-salt")
	expect(Object.keys($public)).not.toContain("MAILWOMAN_PREMISE_LINKAGE_SALT")
	expect(Object.keys(corePrivate)).not.toContain("MAILWOMAN_PREMISE_LINKAGE_SALT")
	expect(Object.keys(corePublic)).not.toContain("MAILWOMAN_DIAG_INTERP")
})

test("unrelated invalid core settings do not prevent reading evaluation settings", () => {
	vi.stubEnv("MAILWOMAN_PAIR_PARENT_DELTA", "invalid")
	vi.stubEnv("MAILWOMAN_DIAG_INTERP", "1")
	expect($public.MAILWOMAN_DIAG_INTERP).toBe("1")
})
