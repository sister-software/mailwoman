// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The errors the loader and the recognizer throw.
 *
 *   Each has a stable `name`, so a caller can tell a loading failure from a refused artifact
 *   or a trapped instance without matching message text.
 */

/**
 * The base of every error this package throws on purpose.
 */
export class RecognizeError extends Error {
	override name = "RecognizeError"
}

/**
 * The engine couldn't be instantiated: the binary is invalid, the ABI differs,
 * or synchronous compilation is refused.
 */
export class RecognizeInitializationError extends RecognizeError {
	override name = "RecognizeInitializationError"
}

/**
 * The engine trapped, so the instance is unusable.
 * Every later call throws this error.
 */
export class RecognizeRuntimeError extends RecognizeError {
	override name = "RecognizeRuntimeError"
}

/**
 * The engine refused a family's artifact, such as one whose declarations hash
 * differs from the declarations it is loaded beside.
 */
export class RecognizeArtifactError extends RecognizeError {
	override name = "RecognizeArtifactError"
}
