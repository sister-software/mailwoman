import { z } from "zod"

export const PublicEnvSchema = z.object({
	NODE_ENV: z.enum(["development", "production"]).default("development"),
	CI: z.coerce.boolean().default(false),
})

export const PrivateEnvSchema = z.object({
	HF_BUCKET_URI: z.string().optional(),
	HF_ORG_NAME: z.string().optional(),
	HF_BUCKET_NAME: z.string().optional(),
	HF_BUCKET_RESOLVE_URL: z.url().optional(),
	HF_TOKEN: z.string().min(1, "HF_TOKEN required").optional(),

	CF_AUTH_TOKEN: z.string().optional(),
	GEOCODE_EARTH_API_KEY: z.string().optional(),
})
