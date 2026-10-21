/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `POST /v1/downloads` answers a presigned URL for a paid artifact to a token that admits it. The token is verified
 *   offline against the register and this worker's own key, its scope must admit the artifact, and a token with a lid
 *   must stand `active` in the ledger. A hand-issued token has no lid and is admitted on the offline verification
 *   alone, so an enterprise licensee downloads without a ledger row. Every grant is a `downloads` row.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import { publicKeyFromPrivateKey } from "@mailwoman/core/crypto/ed25519"
import { scopeAdmits, verifyLicenseKey } from "@mailwoman/core/license/key"
import { trustedLicenseSigningKeys } from "@mailwoman/core/license/register"

import type { ArtifactCatalog } from "#artifacts/catalog"
import { PRESIGN_SECONDS, presignConfigured, presignedArtifactURL } from "#artifacts/presign"
import type { LicenseWorkerEnv } from "#env"
import { newDownloadID } from "#identifiers"
import type { Ledger } from "#ledger/client"
import { findDeclaration, recordDownload } from "#ledger/declarations"
import { findLicense } from "#ledger/licenses"
import { publicLicenseStatus } from "#policy"
import { clientAddress, withinLimits } from "#routes/rate-limit"

export interface DownloadDependencies {
	ledger: Ledger
	artifacts: ArtifactCatalog
	now?: () => number
}

const ErrorSchema = z.object({ error: z.string() })

/**
 * The body of a download request: the token, the artifact's scope entry, and the installation id.
 */
export const DownloadBodySchema = z.object({
	token: z.string().min(1),
	artifact: z.string().min(1),
	install: z.uuid().optional(),
})

/**
 * A granted download: the presigned URL, the instant it stops working, and the object's size when known.
 */
export const DownloadGrantSchema = z.object({
	status: z.literal("granted"),
	url: z.string(),
	expires: z.string(),
	bytes: z.number().nullable(),
})

const downloadRoute = createRoute({
	method: "post",
	path: "/v1/downloads",
	request: {
		body: { content: { "application/json": { schema: DownloadBodySchema } }, required: true },
	},
	responses: {
		200: {
			description: "A presigned URL for the artifact, valid for one hour.",
			content: { "application/json": { schema: DownloadGrantSchema } },
		},
		400: {
			description: "The artifact is outside the catalog.",
			content: { "application/json": { schema: ErrorSchema } },
		},
		403: {
			description: "The token does not admit the artifact; the error word says why.",
			content: { "application/json": { schema: ErrorSchema } },
		},
		429: {
			description: "Too many downloads from this address.",
			content: { "application/json": { schema: ErrorSchema } },
		},
		503: {
			description: "The private bucket is not provisioned.",
			content: { "application/json": { schema: ErrorSchema } },
		},
	},
})

/**
 * The keys a token may be signed by: the shipped register plus this worker's own key,
 * which in a sandbox is outside the register.
 */
async function trustedKeys(env: LicenseWorkerEnv): Promise<Readonly<Record<string, string>>> {
	return {
		...trustedLicenseSigningKeys(),
		[env.LICENSE_SIGNING_KID]: await publicKeyFromPrivateKey(env.LICENSE_SIGNING_KEY_PEM),
	}
}

export function registerDownloadRoute(app: OpenAPIHono, env: LicenseWorkerEnv, deps: DownloadDependencies): void {
	app.openapi(downloadRoute, async (c) => {
		const { token, artifact, install } = c.req.valid("json")

		if (!(await withinLimits(env.DOWNLOAD_LIMITER, [`ip:${clientAddress(c)}`]))) {
			return c.json({ error: "rate limited" }, 429)
		}

		if (!presignConfigured(env)) return c.json({ error: "downloads unavailable" }, 503)

		const entry = deps.artifacts[artifact]

		if (!entry) return c.json({ error: "unknown artifact" }, 400)

		const now = (deps.now ?? Date.now)()
		const verification = await verifyLicenseKey(token, { trustedKeys: await trustedKeys(env), now: new Date(now) })

		if (verification.status !== "valid") return c.json({ error: verification.status }, 403)

		const { payload } = verification

		// A multi-artifact bundle requests `<tier>/<path>`; the scope admits the tier, the catalog holds the path.
		const slash = artifact.indexOf("/")
		const scopeEntry = slash === -1 ? artifact : artifact.slice(0, slash)

		if (!scopeAdmits(payload.scope, scopeEntry)) return c.json({ error: "scope" }, 403)

		if (typeof payload.lid === "string") {
			const holder = (await findLicense(deps.ledger, payload.lid)) ?? (await findDeclaration(deps.ledger, payload.lid))

			if (!holder) return c.json({ error: "unknown" }, 403)

			const standing = publicLicenseStatus(holder.license_state)

			if (standing !== "active") return c.json({ error: standing }, 403)
		}

		const url = await presignedArtifactURL(env, entry.key)

		await recordDownload(deps.ledger, {
			download_id: newDownloadID(),
			lid: payload.lid ?? null,
			kid: payload.kid,
			licensee: payload.licensee,
			install: install ?? payload.install ?? null,
			artifact,
		})

		return c.json(
			{
				status: "granted" as const,
				url,
				expires: new Date(now + PRESIGN_SECONDS * 1000).toISOString(),
				bytes: entry.bytes,
			},
			200
		)
	})
}
