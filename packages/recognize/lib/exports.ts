// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The public API both entries export.
 *
 *   The default entry and the workerd entry differ only in where the engine binary comes from.
 */

export type {
	AnyFamily,
	FamilyDeclaration,
	FieldsOf,
	Handler,
	HandlerMap,
	KindsOf,
	Recognition,
	RecognitionsOf,
	Rejected,
	Rejection,
	Unvalidated,
	Validated,
} from "#family"

export { defineFamily } from "#family"
export { createRecognizer, type RecognizeResult, type Recognizer } from "#recognizer"

export {
	RecognizeArtifactError,
	RecognizeError,
	RecognizeInitializationError,
	RecognizeRuntimeError,
} from "#runtime/errors"

export { init, type InitOptions } from "#runtime/state"
