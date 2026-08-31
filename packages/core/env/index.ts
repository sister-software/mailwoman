import { join } from "path-ts"
import type { z } from "zod"

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

function liveEnv<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>): z.infer<z.ZodObject<Shape>> {
	const view = {} as z.infer<z.ZodObject<Shape>>

	for (const key of Object.keys(schema.shape)) {
		Object.defineProperty(view, key, {
			enumerable: true,
			// oxlint-disable-next-line sister-software/no-process-globals -- this module is the typed process.env boundary
			get: () => schema.parse(process.env)[key as keyof z.infer<z.ZodObject<Shape>>],
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
