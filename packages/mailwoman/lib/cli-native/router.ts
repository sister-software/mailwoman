/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Static, dependency-light command routing. Summaries live here so root help can eventually list every command without
 * importing their implementations. A loader is the only edge from the router to a command module.
 */

import type { UnsafeCLIArguments } from "@mailwoman/core/scripting/arguments"

export interface NativeCommandModule {
	run(args: readonly string[]): Promise<number>
}

export interface NativeCommandRoute {
	summary: string
	load(): Promise<NativeCommandModule>
}

/**
 * Native commands keyed by their public command name.
 */
export const nativeCommandRoutes: Readonly<Record<string, NativeCommandRoute>> = {
	autocomplete: {
		summary: "Complete a place-name prefix from the FST gazetteer.",
		load: () => import("#cli-native/commands/autocomplete"),
	},
	doctor: {
		summary: "Check runtime, model, and optional data readiness.",
		load: () => import("#cli-native/commands/doctor"),
	},
	geocode: {
		summary: "Turn an address into a coordinate.",
		load: () => import("#cli-native/commands/geocode"),
	},
	license: {
		summary: "Mint, issue and verify commercial license keys.",
		load: () => import("#cli-native/commands/license"),
	},
	openapi: {
		summary: "Emit the native API OpenAPI document.",
		load: () => import("#cli-native/commands/openapi"),
	},
	reverse: {
		summary: "Resolve a coordinate to its administrative hierarchy.",
		load: () => import("#cli-native/commands/reverse"),
	},
}

/**
 * Dispatch a direct command, or return `undefined` so the caller can try the filesystem command tree.
 */
export function dispatchNativeCommand(userArguments: UnsafeCLIArguments): Promise<number | void> {
	const [name, ...args] = userArguments
	const route = name ? nativeCommandRoutes[name] : undefined

	if (!route) return Promise.resolve()

	return route.load().then((module) => module.run(args))
}
