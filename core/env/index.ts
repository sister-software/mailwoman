import { z } from "zod"

import { loadEnvFile } from "./load.js"
import { cwdPathBuilder } from "./paths.js"
import { PrivateEnvSchema, PublicEnvSchema } from "./schema.js"

// The optional `.env` is read once (it can't change mid-process); the real environment is layered on top
// LIVE. `process.env` can change during a process — a test stubbing a var, a late setter — and `$public` /
// `$private` must reflect it, exactly like `process.env` itself. So each key is a getter that re-parses the
// current `{ ...dotEnv, ...process.env }` on access. The schemas enumerate the keys we know about; `z.object`
// strips the rest of `process.env`, so only declared keys ever surface, typed.
const dotEnv = loadEnvFile(cwdPathBuilder(".env"))

function liveEnv<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>): z.infer<z.ZodObject<Shape>> {
	const view = {} as z.infer<z.ZodObject<Shape>>

	for (const key of Object.keys(schema.shape)) {
		Object.defineProperty(view, key, {
			enumerable: true,
			get: () => schema.parse({ ...dotEnv, ...process.env })[key as keyof z.infer<z.ZodObject<Shape>>],
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
