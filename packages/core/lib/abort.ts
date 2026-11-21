// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Typed reasons for an aborted `AbortSignal`.
 *
 *   A signal reports only that it aborted, and its `reason` is whatever the aborting code passed.
 *   Code that reacts differently to a cancelled query, a passed deadline, a newer request
 *   and a disposed scope otherwise has to compare signal identities or match error names.
 *
 *   {@linkcode AbortReason} is the reason this repository's code aborts with, and
 *   {@linkcode abortKindOf} reads the kind back from any signal, including one a platform API aborted.
 *
 *   The module imports no other module, so it adds only its own bytes to a browser or Worker bundle.
 */

/**
 * Why a signal aborted.
 */
export const AbortKind = {
	/**
	 * The caller cancelled the work, as when a reader types a new query or leaves the page.
	 */
	Caller: "caller",
	/**
	 * A time limit passed before the work finished.
	 */
	Deadline: "deadline",
	/**
	 * Newer work replaced this work, as when a second load starts before the first has finished.
	 */
	Superseded: "superseded",
	/**
	 * The scope that owned the work was disposed, as when a service registry shuts down.
	 */
	ScopeDisposed: "scope-disposed",
} as const

export type AbortKind = (typeof AbortKind)[keyof typeof AbortKind]

const DEFAULT_MESSAGES: Record<AbortKind, string> = {
	[AbortKind.Caller]: "The caller cancelled the operation.",
	[AbortKind.Deadline]: "The operation passed its deadline.",
	[AbortKind.Superseded]: "A newer operation replaced this one.",
	[AbortKind.ScopeDisposed]: "The scope that owned the operation was disposed.",
}

/**
 * The reason to abort a controller with: `controller.abort(new AbortReason(AbortKind.Superseded))`.
 *
 * Its `name` is `AbortError`, the name `fetch` and the platform's own aborts use,
 * so code that already tests for that name keeps working.
 */
export class AbortReason extends Error {
	readonly kind: AbortKind

	constructor(kind: AbortKind, message: string = DEFAULT_MESSAGES[kind], options?: ErrorOptions) {
		super(message, options)

		this.name = "AbortError"
		this.kind = kind
	}
}

/**
 * The name the platform gives the reason of `AbortSignal.timeout()`.
 */
const TIMEOUT_ERROR_NAME = "TimeoutError"

/**
 * The code `async-init` gives the reason a disposing `ServiceRegistry` aborts its signal with.
 */
const DISPOSED_ERROR_CODE = "E_DISPOSED"

/**
 * Why `signal` aborted, or `null` for a signal that's still live.
 *
 * - An {@linkcode AbortReason} answers its own kind.
 * - The reason of `AbortSignal.timeout()` answers {@linkcode AbortKind.Deadline}.
 * - The reason of a disposing `async-init` registry answers {@linkcode AbortKind.ScopeDisposed}.
 * - Any other reason, including the platform's default, answers {@linkcode AbortKind.Caller}.
 *
 * A signal from `AbortSignal.any()` has the reason of the source that aborted first,
 * so this reads which of a caller's signal and a deadline ended the work.
 */
export function abortKindOf(signal: AbortSignal): AbortKind | null {
	if (!signal.aborted) return null

	const reason: unknown = signal.reason

	if (reason instanceof AbortReason) return reason.kind

	if (typeof reason === "object" && reason !== null) {
		if ("name" in reason && reason.name === TIMEOUT_ERROR_NAME) return AbortKind.Deadline

		if ("code" in reason && reason.code === DISPOSED_ERROR_CODE) return AbortKind.ScopeDisposed
	}

	return AbortKind.Caller
}
