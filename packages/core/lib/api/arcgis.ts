/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   ArcGIS REST errors arrive under HTTP 200 as a JSON envelope, `{ "error": { "code", "message", "details" } }`, so
 *   nothing upstream maps them: a caller that reads `data.features` off an error body gets `undefined` and reports an
 *   empty layer, or a message about a missing field that names the wrong fact. Every ArcGIS JSON read a layer product
 *   makes goes through {@link assertNoArcGISError} before it reads a field.
 */

export interface ArcGISErrorEnvelope {
	code?: number
	message: string
	details?: string[]
}

/**
 * The error an ArcGIS error envelope becomes.
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
 * The error envelope inside an ArcGIS JSON body, or `undefined` when the body is an answer. Only an object whose
 * `error` carries a string `message` counts: a feature attribute that happens to be named `error` is data.
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
 * Refuse an ArcGIS JSON body that is an error envelope.
 */
export function assertNoArcGISError(payload: unknown, context: string): void {
	const error = readArcGISError(payload)

	if (error) {
		throw new ArcGISServiceError(context, error)
	}
}
