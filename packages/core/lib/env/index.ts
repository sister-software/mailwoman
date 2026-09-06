/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { join } from "path-ts"
import type z from "zod"

import { PrivateEnvSchema, PublicEnvSchema } from "#env/schema"

export { DefaultMailwomanPaths } from "#env/paths"

/**
 * The `.env` layer, folded into `process.env` when this module is evaluated — process-startup semantics.
 *
 * `process.loadEnvFile` is the runtime's own reader: synchronous, so the views below can expose synchronous getters
 * without a top-level `await` (which the Docusaurus config loader cannot evaluate), and not a filesystem call made by
 * repository code. A variable already in `process.env` wins over the file, which is the precedence the views always
 * had. An absent `.env` is the common case and is not an error.
 */
try {
	// oxlint-disable-next-line sister-software/no-process-globals -- this module is the typed process.env boundary
	process.loadEnvFile(join(process.cwd(), ".env"))
} catch {
	// No `.env` beside the working directory — `process.env` alone is the environment.
}

/**
 * Create a live environment view, optionally extending another view without evaluating its getters. Each field caches
 * its last validation result until its raw environment value changes, including changes to absence. Inherited getters
 * share the base view's cache. Duplicate keys are rejected.
 *
 * Fields must validate independently: object-level refinements are rejected by Zod's `pick`. Defaults and transforms
 * run only when the raw value changes, so they must not depend on other mutable state.
 */
export function liveEnv<Shape extends z.ZodRawShape, Base extends object = Record<never, never>>(
	schema: z.ZodObject<Shape>,
	base?: Base
): Base & z.infer<z.ZodObject<Shape>> {
	const view = Object.defineProperties({}, base ? Object.getOwnPropertyDescriptors(base) : {}) as Base &
		z.infer<z.ZodObject<Shape>>

	for (const key of Object.keys(schema.shape)) {
		if (Object.hasOwn(view, key)) throw new Error(`Environment field already inherited: ${key}`)

		// Keep the object wrapper so validation issues still identify the environment variable by name.
		const fieldSchema = schema.pick({ [key]: true } as Parameters<typeof schema.pick>[0])

		let previous: string | undefined
		let cached: ReturnType<typeof fieldSchema.safeParse> | undefined

		Object.defineProperty(view, key, {
			enumerable: true,
			get: () => {
				// oxlint-disable-next-line sister-software/no-process-globals -- this module is the typed process.env boundary
				const raw = process.env[key]

				if (!cached || raw !== previous) {
					cached = fieldSchema.safeParse({ [key]: raw })
					previous = raw
				}

				if (!cached.success) throw cached.error

				return cached.data[key as keyof typeof cached.data]
			},
		})
	}

	return view
}

/**
 * Publicly accessible environment — non-secret operational config (DB paths, batch tuning, `NODE_ENV`). Safe to log. A
 * live, typed view over `process.env` layered on an optional `.env`; only keys in {@link PublicEnvSchema} appear.
 *
 * @see {@link $private} for secrets (tokens, upload credentials).
 */
export const $public = liveEnv(PublicEnvSchema)

/**
 * Privately accessible environment — secrets and credentials (HF token, API keys, rclone S3 creds). Do NOT log. A live,
 * typed view over `process.env` layered on an optional `.env`; only keys in {@link PrivateEnvSchema} appear.
 *
 * @see {@link $public} for non-secret operational config.
 */
export const $private = liveEnv(PrivateEnvSchema)
