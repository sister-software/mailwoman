/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   ArcGIS REST services return errors with HTTP 200 as a JSON `error` envelope. Layer products pass every ArcGIS
 *   JSON body through {@link assertNoArcGISError} before reading fields, so an error is not read as an empty layer.
 */

/**
 * The `error` object in an ArcGIS JSON body.
 */
export interface ArcGISErrorEnvelope {
	code?: number
	message: string
	details?: string[]
}

/**
 * An error thrown for an ArcGIS error envelope.
 */
export class ArcGISServiceError extends Error {
	public readonly code: number | undefined
	public readonly details: readonly string[]

	constructor(context: string, envelope: ArcGISErrorEnvelope) {
		const details = envelope.details?.length ? ` (${envelope.details.join("; ")})` : ""

		super(
			`${context}: the ArcGIS service answered an error${envelope.code === undefined ? "" : ` ${envelope.code}`} — ${envelope.message}${details}`
		)

		this.name = "ArcGISServiceError"
		this.code = envelope.code
		this.details = envelope.details ?? []
	}
}

/**
 * Returns the error envelope in an ArcGIS JSON body, or `undefined` when the body is a normal response.
 *
 * The body counts as an error only when its `error` object has a string `message`.
 */
export function readArcGISError(payload: unknown): ArcGISErrorEnvelope | undefined {
	if (typeof payload !== "object" || payload === null) return undefined

	const error = (payload as { error?: unknown }).error

	if (typeof error !== "object" || error === null) return undefined

	const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown }

	if (typeof message !== "string") return undefined

	return {
		...(typeof code === "number" ? { code } : {}),
		message,
		...(Array.isArray(details) ? { details: details.filter((d): d is string => typeof d === "string") } : {}),
	}
}

/**
 * Throws {@link ArcGISServiceError} when an ArcGIS JSON body is an error envelope.
 */
export function assertNoArcGISError(payload: unknown, context: string): void {
	const error = readArcGISError(payload)

	if (error) {
		throw new ArcGISServiceError(context, error)
	}
}
