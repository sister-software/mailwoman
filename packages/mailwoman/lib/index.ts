// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export { createParser, parse, type Parser, type ParserOptions } from "#parser"

// The declarations below belong to `@mailwoman/core` and `@mailwoman/codex`.
// Each type appears in a signature exported above, and `walkNodes`, `decodeAsJSON`
// and `decodeAsTuples` read the tree a parse returns, so a consumer who installed
// only `mailwoman` imports them from here.
export type { ComponentTag } from "@mailwoman/codex/component"
export { type AddressNode, type AddressTree, decodeAsJSON, decodeAsTuples, walkNodes } from "@mailwoman/core/decoder"

export type {
	CaseNormalization,
	MachinePreferences,
	PipelineOpts,
	PipelineResult,
	PlacerCountryUse,
	StageSource,
} from "@mailwoman/core/pipeline"
