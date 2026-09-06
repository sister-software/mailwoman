/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { $private as corePrivate, $public as corePublic } from "@mailwoman/core/env"
import { $private, $public } from "@mailwoman/release-kit/env"
import { $public as resolverPublic } from "@mailwoman/resolver-wof-sqlite/env"
import { afterEach, expect, test, vi } from "vitest"

afterEach(() => vi.unstubAllEnvs())

test("release views inherit live core and resolver settings", () => {
	vi.stubEnv("MAILWOMAN_DATA_ROOT", "/tmp/release-env-first")
	vi.stubEnv("MAILWOMAN_DEV_MODEL", "/tmp/dev-first.onnx")
	expect($public.MAILWOMAN_DATA_ROOT).toBe(corePublic.MAILWOMAN_DATA_ROOT)
	expect($public.MAILWOMAN_DEV_MODEL).toBe(resolverPublic.MAILWOMAN_DEV_MODEL)
	vi.stubEnv("MAILWOMAN_DATA_ROOT", "/tmp/release-env-second")
	vi.stubEnv("MAILWOMAN_DEV_MODEL", "/tmp/dev-second.onnx")
	expect($public.MAILWOMAN_DATA_ROOT).toBe("/tmp/release-env-second")
	expect($public.MAILWOMAN_DEV_MODEL).toBe("/tmp/dev-second.onnx")
})

test("release settings follow environment changes through the package entry point", () => {
	vi.stubEnv("MAILWOMAN_PUBLISH_MODEL", "first.onnx")
	expect($public.MAILWOMAN_PUBLISH_MODEL).toBe("first.onnx")
	vi.stubEnv("MAILWOMAN_PUBLISH_MODEL", "second.onnx")
	expect($public.MAILWOMAN_PUBLISH_MODEL).toBe("second.onnx")
})

test("release credentials stay private and package-owned", () => {
	vi.stubEnv("RELEASE_IT_WORKSPACES_OTP", "123456")
	vi.stubEnv("HF_BUCKET_RESOLVE_URL", "https://huggingface.co/buckets/sister-software/mailwoman/resolve/")
	expect($private.RELEASE_IT_WORKSPACES_OTP).toBe("123456")
	expect($private.HF_BUCKET_RESOLVE_URL).toBe("https://huggingface.co/buckets/sister-software/mailwoman/resolve/")
	expect(Object.keys($public)).not.toContain("RELEASE_IT_WORKSPACES_OTP")
	expect(Object.keys(corePrivate)).toEqual([])
	expect(Object.keys(corePublic)).not.toContain("MAILWOMAN_PUBLISH_MODEL")
})
