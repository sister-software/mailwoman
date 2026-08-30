import { join } from "@mailwoman/platform/path"
import type { z } from "zod"

import { loadEnvFile } from "./load.ts"
import { PrivateEnvSchema, PublicEnvSchema } from "./schema.ts"

export { DefaultMailwomanPaths } from "./paths.ts"

/**
 * The `.env` layer, resolved when this module is evaluated — process-startup semantics.
 *
 * The load is asynchronous, so it cannot be deferred to the first property read: the views below expose synchronous
 * getters. Reading `process.cwd()` once, at module evaluation, keeps the `.env` half answering about the same moment as
 * the `process.env` half (which still re-parses on every get), and a property get costs a map lookup rather than a file
 * read.
 */
const dotEnvByDirectory = new Map<string, object>([[process.cwd(), await loadEnvFile(join(process.cwd(), ".env"))]])

function dotEnv(): object {
	return dotEnvByDirectory.get(process.cwd()) ?? {}
}

function liveEnv<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>): z.infer<z.ZodObject<Shape>> {
	const view = {} as z.infer<z.ZodObject<Shape>>

	for (const key of Object.keys(schema.shape)) {
		Object.defineProperty(view, key, {
			enumerable: true,
			// oxlint-disable-next-line sister-software/no-process-globals -- this module is the typed process.env boundary
			get: () => schema.parse({ ...dotEnv(), ...process.env })[key as keyof z.infer<z.ZodObject<Shape>>],
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
