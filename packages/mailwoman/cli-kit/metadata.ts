// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export interface CommandArgumentMetadata {
	name: string
	description?: string
	default?: string
}

/**
 * Attach CLI presentation metadata to a positional-argument schema.
 *
 * The encoded description remains readable by the transitional schema adapter. Native commands express positionals
 * directly in `CommandSpec` and do not need this helper.
 */
export function argument(config: CommandArgumentMetadata): string {
	return `__mailwoman_argument_config__${JSON.stringify(config)}`
}
