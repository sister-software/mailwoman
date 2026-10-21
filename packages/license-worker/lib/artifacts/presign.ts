/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A paid artifact is served from a private R2 bucket by a presigned S3 URL that expires within the hour. An R2
 *   binding cannot presign, so the worker holds S3 API credentials for the bucket as secrets and signs with SigV4
 *   through `aws4fetch`, which runs on WebCrypto and so on the Workers runtime.
 */

import { AwsClient } from "aws4fetch"

/**
 * The seconds a presigned URL stays valid.
 */
export const PRESIGN_SECONDS = 3600

/**
 * The bindings presigning reads.
 *
 * The two secrets arrive through `wrangler secret put`.
 * The endpoint and the bucket are vars in `wrangler.toml`.
 */
export interface PresignBindings {
	R2_ACCESS_KEY_ID?: string
	R2_SECRET_ACCESS_KEY?: string
	/**
	 * The bucket's S3 API origin, `https://<account>.<jurisdiction>.r2.cloudflarestorage.com`.
	 *
	 * A bucket created under a jurisdiction answers only on that jurisdiction's host,
	 * so the var holds the whole origin rather than the account id.
	 */
	R2_S3_ENDPOINT?: string
	PAID_ARTIFACTS_BUCKET?: string
}

type ConfiguredPresign = Required<{ [Key in keyof PresignBindings]: string }>

/**
 * Whether every value presigning needs is set.
 */
export function presignConfigured(env: PresignBindings): env is ConfiguredPresign {
	return (
		typeof env.R2_ACCESS_KEY_ID === "string" &&
		env.R2_ACCESS_KEY_ID.length > 0 &&
		typeof env.R2_SECRET_ACCESS_KEY === "string" &&
		env.R2_SECRET_ACCESS_KEY.length > 0 &&
		typeof env.R2_S3_ENDPOINT === "string" &&
		env.R2_S3_ENDPOINT.length > 0 &&
		typeof env.PAID_ARTIFACTS_BUCKET === "string" &&
		env.PAID_ARTIFACTS_BUCKET.length > 0
	)
}

/**
 * A presigned GET of one object in the private bucket.
 *
 * @throws when the bindings are not configured.
 * Callers check `presignConfigured` first and answer 503.
 */
export async function presignObject(
	env: PresignBindings,
	key: string,
	expiresSeconds: number = PRESIGN_SECONDS
): Promise<string> {
	if (!presignConfigured(env)) throw new Error("the paid-artifact bucket is not configured")

	const client = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: "s3",
		region: "auto",
	})

	// Resolved against the origin, so a trailing slash on the endpoint still yields one slash before the bucket.
	const url = new URL(`${env.PAID_ARTIFACTS_BUCKET}/${key}`, env.R2_S3_ENDPOINT)

	url.searchParams.set("X-Amz-Expires", String(expiresSeconds))

	const signed = await client.sign(new Request(url, { method: "GET" }), { aws: { signQuery: true } })

	return signed.url
}
