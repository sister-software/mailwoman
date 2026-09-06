/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { $private as corePrivate, $public as corePublic } from "@mailwoman/core/env"
import { $private, $public } from "@mailwoman/release-kit/env"
import { afterEach, expect, test, vi } from "vitest"

afterEach(() => vi.unstubAllEnvs())

test("release views inherit live core settings and credentials", () => {
	vi.stubEnv("MAILWOMAN_DATA_ROOT", "/tmp/release-env-first")
	vi.stubEnv("HF_TOKEN", "test-token")
	expect($public.MAILWOMAN_DATA_ROOT).toBe(corePublic.MAILWOMAN_DATA_ROOT)
	expect($private.HF_TOKEN).toBe(corePrivate.HF_TOKEN)
	expect(Object.keys($public)).not.toContain("HF_TOKEN")
	vi.stubEnv("MAILWOMAN_DATA_ROOT", "/tmp/release-env-second")
	expect($public.MAILWOMAN_DATA_ROOT).toBe("/tmp/release-env-second")
})

test("release settings follow environment changes through the package entry point", () => {
	vi.stubEnv("MAILWOMAN_PUBLISH_MODEL", "first.onnx")
	expect($public.MAILWOMAN_PUBLISH_MODEL).toBe("first.onnx")
	vi.stubEnv("MAILWOMAN_PUBLISH_MODEL", "second.onnx")
	expect($public.MAILWOMAN_PUBLISH_MODEL).toBe("second.onnx")
})

test("release credentials stay private and package-owned", () => {
	vi.stubEnv("RELEASE_IT_WORKSPACES_OTP", "123456")
	expect($private.RELEASE_IT_WORKSPACES_OTP).toBe("123456")
	expect(Object.keys($public)).not.toContain("RELEASE_IT_WORKSPACES_OTP")
	expect(Object.keys(corePrivate)).not.toContain("RELEASE_IT_WORKSPACES_OTP")
	expect(Object.keys(corePublic)).not.toContain("MAILWOMAN_PUBLISH_MODEL")
})

test("unrelated invalid core settings do not prevent reading release settings", () => {
	vi.stubEnv("MAILWOMAN_BATCH_MAX", "invalid")
	vi.stubEnv("MAILWOMAN_PUBLISH_MODEL", "release.onnx")
	expect($public.MAILWOMAN_PUBLISH_MODEL).toBe("release.onnx")
})
