/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Environment variables naming the WOF SQLite artifacts this resolver opens, and the development weights the overlay
 *   linker materializes. CLI flags (`--resolve-db`, …) override these at the call site.
 */

import { $public as corePublic, liveEnv } from "@mailwoman/core/env"
import { z } from "zod"

/**
 * Gazetteer and resolver database paths, plus the development weights overlay.
 */
export const PublicWOFSQLiteEnvSchema = z.object({
	MAILWOMAN_WOF_DB: z.string().optional().meta({
		title: "Who's On First database",
		description: "Path to a full Who's On First SQLite distribution used by the search resolver backend.",
	}),
	MAILWOMAN_WOF_ADMIN_DB: z.string().optional().meta({
		title: "Who's On First admin database",
		description: "Path to the full Who's On First distribution used for reverse geocoding.",
	}),
	MAILWOMAN_WOF_POLYGONS_DB: z.string().optional().meta({
		title: "Who's On First polygon database",
		description: "Path to the polygon sidecar used for exact reverse-geocode containment.",
	}),
	MAILWOMAN_CANDIDATE_DB: z.string().optional().meta({
		title: "Candidate database",
		description: "Path to candidate.db; set to `none` to pin the full-distribution search backend.",
	}),
	MAILWOMAN_POSTAL_CITY_ALIAS_DB: z.string().optional().meta({
		title: "Postal city alias database",
		description: "Path to postal-city alias data used for alias-aware resolution of U.S. mailing addresses.",
	}),
	MAILWOMAN_DEV_MODEL: z.string().optional().meta({
		title: "Development model",
		description: "Path to the model artifact linked for local neural-weights development.",
	}),
	MAILWOMAN_DEV_TOKENIZER: z.string().optional().meta({
		title: "Development tokenizer",
		description: "Path to the tokenizer artifact linked for local neural-weights development.",
	}),
})

/**
 * Live resolver settings over core's, sharing core's getters and cached values.
 */
export const $public = liveEnv(PublicWOFSQLiteEnvSchema, corePublic)
