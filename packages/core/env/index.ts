import { join } from "@mailwoman/platform/path"
import type { z } from "zod"

import { loadEnvFile } from "./load.ts"
import { PrivateEnvSchema, PublicEnvSchema } from "./schema.ts"

export { DefaultMailwomanPaths } from "./paths.ts"

/**
 * The `.env` layer, resolved the first time a property is read rather than when this module is evaluated.
 *
 * Reading `process.cwd()` at module scope froze the layer to whichever directory the process started in, so the two
 * halves of the view below disagreed about when they were sampled: the `process.env` half re-parses on every get, the
 * `.env` half never did. A CLI invoked from a subdirectory therefore read no `.env` at all while still reporting itself
 * as a live view. Resolving per directory keeps both halves answering about the same moment; the memo means a property
 * get costs a map lookup rather than a file read.
 */
const dotEnvByDirectory = new Map<string, object>()

function dotEnv(): object {
	const directory = process.cwd()
	const loaded = dotEnvByDirectory.get(directory) ?? loadEnvFile(join(directory, ".env"))

	dotEnvByDirectory.set(directory, loaded)

	return loaded
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
