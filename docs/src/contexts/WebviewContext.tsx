/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createContext, SetStateAction, useCallback, useContext } from "react"
import type { ViewState } from "react-map-gl"

export interface NexusWebviewState {
	version: number
	mapView: ViewState
}

const SERIALIZED_STATE_SCHEMA_VERSION = 1

/**
 * Default viewport state for the map,
 */
const DEFAULT_SERIALIZED_STATE = {
	version: SERIALIZED_STATE_SCHEMA_VERSION,
	mapView: {
		longitude: -94.38,
		latitude: 36.5,
		zoom: 4,
		pitch: 50,
		bearing: 0,
	},
} as const satisfies NexusWebviewState

/**
 * Hook for using the VS Code webview API.
 */
export const useWebviewContext = () => useContext(WebviewContext)

export type PersistWebviewStateFn = (nextWebviewState: SetStateAction<NexusWebviewState>) => void

export interface WebviewContextValue {
	persistWebviewState: PersistWebviewStateFn
	initialWebviewState: NexusWebviewState
}

/**
 * React context for working with the VS Code webview.
 */
const WebviewContext = createContext<WebviewContextValue>({
	initialWebviewState: structuredClone(DEFAULT_SERIALIZED_STATE),
	persistWebviewState: () => {
		console.warn("persistWebviewState called before context was initialized")
	},
})

function validateSerializedState(input: unknown): asserts input is NexusWebviewState {
	if (!input) throw new Error("No serialized state found")

	if (typeof input !== "object") throw new Error("Serialized state is not an object")

	if (!("version" in input) || typeof input.version !== "number") throw new Error("Serialized state is missing version")

	if (input.version !== SERIALIZED_STATE_SCHEMA_VERSION) throw new Error("Serialized state schema version mismatch")
}

/**
 * Pluck the serialized state from the VS Code API.
 *
 * Should be called once on startup.
 */
export function pluckSerializedState(): NexusWebviewState {
	let serializedState: unknown = null

	try {
		serializedState = JSON.parse(localStorage.getItem("webview-state") || "null")
	} catch (error) {
		console.warn("Failed to parse serialized state", error)
		return DEFAULT_SERIALIZED_STATE
	}

	try {
		validateSerializedState(serializedState)
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error"

		console.warn("Failed to pluck serialized state", message)
		return DEFAULT_SERIALIZED_STATE
	}

	console.log("Plucked serialized state", serializedState)
	return serializedState
}

export interface NexusStateProviderProps {
	initialWebviewState: NexusWebviewState
	children: React.ReactNode
}

/**
 * Provides the webview state context.
 */
export const NexusStateProvider: React.FC<NexusStateProviderProps> = ({ initialWebviewState, children }) => {
	const persistWebviewState = useCallback<PersistWebviewStateFn>((nextWebviewState) => {
		const value = typeof nextWebviewState === "function" ? nextWebviewState(DEFAULT_SERIALIZED_STATE) : nextWebviewState

		try {
			validateSerializedState(value)
		} catch (error) {
			console.warn("Failed to persist serialized state", error)
			return
		}

		// vscode.setState(value)
	}, [])

	const value = {
		persistWebviewState,
		initialWebviewState,
	}

	return (
		<>
			<WebviewContext.Provider value={value}>{children}</WebviewContext.Provider>
		</>
	)
}
