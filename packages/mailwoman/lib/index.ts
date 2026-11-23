// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export { createParser, type Parser, type ParserOptions } from "#engine/parser"

// The declarations below belong to `@mailwoman/core` and `@mailwoman/codex`.
// Each type appears in a signature exported above, and each function reads the tree a
// parse returns, so a consumer who installed only `mailwoman` imports them from here.
export type { ComponentTag } from "@mailwoman/codex/component"

export {
	type AddressNode,
	type AddressTree,
	decodeAsJSON,
	decodeAsOutline,
	decodeAsTuples,
	type FlatTreeNode,
	flattenTreeNodes,
	groupTuplesByTag,
	walkNodes,
} from "@mailwoman/core/decoder"

export type {
	CaseNormalization,
	MachinePreferences,
	PipelineOpts,
	PipelineResult,
	PlacerCountryUse,
	StageSource,
} from "@mailwoman/core/pipeline"
