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
export class RecognizerError extends Error {
	override name = "RecognizerError"
}

/**
 * The engine couldn't be instantiated: the binary is invalid, the ABI differs,
 * or synchronous compilation is refused.
 */
export class RecognizerInitializationError extends RecognizerError {
	override name = "RecognizerInitializationError"
}

/**
 * The engine trapped, so the instance is unusable.
 * Every later call throws this error.
 */
export class RecognizerRuntimeError extends RecognizerError {
	override name = "RecognizerRuntimeError"
}

/**
 * `createRecognizer` refused a composition of families.
 *
 * A family that fills `knownFormats` reads the tokens of the `structure` family,
 * so a composition that holds the first and not the second is refused.
 * The error is thrown at construction, before any call.
 */
export class RecognizerCompositionError extends RecognizerError {
	override name = "RecognizerCompositionError"
}

/**
 * The engine refused a family's artifact, such as one whose declarations hash
 * differs from the declarations it is loaded beside.
 */
export class RecognizerArtifactError extends RecognizerError {
	override name = "RecognizerArtifactError"
}
