/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The two connectivity signals a browser client reads before it sends a request, and the error a client raises
 *   when they say the request cannot reach its service.
 */

import type { StatusCodes } from "http-status-codes"

import { ResourceError } from "#errors/schema"

/**
 * What a client knows about its connection, from two independent sources.
 *
 * `null` means the source is unavailable or hasn't reported yet.
 * A reading of `false` means the source reported a failure.
 */
export interface ConnectivityReading {
	/**
	 * `navigator.onLine`: `false` when the device has no network interface up.
	 *
	 * `true` reports only that an interface is up.
	 * A captive portal or a network with no route out still reads `true`.
	 */
	online: boolean | null

	/**
	 * Whether the latest reachability probe of the service succeeded.
	 */
	reachable: boolean | null
}

/**
 * The reading a client assumes before either source reports: both signals unknown.
 */
export const UNKNOWN_CONNECTIVITY: ConnectivityReading = { online: null, reachable: null }

/**
 * `navigator.onLine`, or `null` on a runtime whose `navigator` lacks it.
 *
 * Node 21 and later define `navigator` without `onLine`, and workerd's `navigator` lacks
 * it too, so the absent property reads as unknown there rather than as offline.
 */
export function readNavigatorOnline(): boolean | null {
	const navigatorLike = (globalThis as { navigator?: { onLine?: unknown } }).navigator
	const online = navigatorLike?.onLine

	return typeof online === "boolean" ? online : null
}

/**
 * Why a reading rules out a request to its service.
 */
export const OfflineReason = {
	/**
	 * The device reports no network interface up.
	 */
	Offline: "offline",
	/**
	 * The device has a network, and the service's reachability probe failed.
	 */
	Unreachable: "service-unreachable",
} as const

export type OfflineReason = (typeof OfflineReason)[keyof typeof OfflineReason]

/**
 * The reason a reading rules out a request, or `null` when the reading allows one or is unknown.
 */
export function offlineReason(reading: ConnectivityReading): OfflineReason | null {
	if (reading.online === false) return OfflineReason.Offline

	if (reading.reachable === false) return OfflineReason.Unreachable

	return null
}

/**
 * The URN source segment of an error {@linkcode offlineResourceError} builds.
 */
const CONNECTIVITY_ERROR_SOURCE = "connectivity"

const OFFLINE_MESSAGES: Record<OfflineReason, string> = {
	[OfflineReason.Offline]: "This device is offline.",
	[OfflineReason.Unreachable]: "This device has a network connection, but the service did not answer.",
}

/**
 * A 503 {@linkcode ResourceError} of kind `network` for a request that a connectivity reading ruled out.
 *
 * The `network` kind segment matches `ResourceErrorKind.Network`, the kind `APIClient`
 * assigns a responseless failure, so `isTransientResourceError` reports it as transient
 * and a caller that requeues network failures requeues this one.
 * The URN is `connectivity:network:<reason>`, and `cause` holds the failure
 * that prompted the check, if one did.
 */
export function offlineResourceError(reason: OfflineReason, cause?: unknown): ResourceError {
	const error = ResourceError.from(
		503 as StatusCodes,
		OFFLINE_MESSAGES[reason],
		CONNECTIVITY_ERROR_SOURCE,
		"network",
		reason
	)

	if (cause != null) {
		error.cause = cause
	}

	return error
}
