/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Environment variables naming the browser-shaped WOF artifact this resolver and its evaluations open.
 */

import { $public as corePublic, liveEnv } from "@mailwoman/core/env"
import { z } from "zod"

/**
 * The hot-set WOF database the WASM resolver serves.
 */
export const PublicWOFWASMEnvSchema = z.object({
	MAILWOMAN_WOF_HOT_DB: z.string().optional().meta({
		title: "WOF hot database",
		description: "Path to the hot-set Who's On First database the WASM resolver and its evaluations open.",
	}),
})

/**
 * Live WASM resolver settings over core's, sharing core's getters and cached values.
 */
export const $public = liveEnv(PublicWOFWASMEnvSchema, corePublic)
