/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The bare MapLibre control both debug panels portal into.
 *
 *   `DashboardMap`'s inspector and the demo page's `_debug.tsx` panel each need an `IControl` whose
 *   only job is to own a container element for `createPortal`. The class was duplicated in both;
 *   the position and container class are the only differences, so they are parameters here.
 */

import type { ControlPosition } from "maplibre-gl"
import type { IControl, MapInstance } from "react-map-gl/maplibre"

export interface DebugControlBaseOptions {
	/**
	 * Class applied to the portal container.
	 */
	className?: string
	/**
	 * Where MapLibre docks the control. @default "bottom-left"
	 */
	position?: ControlPosition
}

export class DebugControlBase implements IControl {
	public readonly container: HTMLElement
	readonly #position: ControlPosition

	constructor({ className, position = "bottom-left" }: DebugControlBaseOptions = {}) {
		this.container = document.createElement("div")

		if (className) {
			this.container.classList.add(className)
		}

		this.#position = position
	}

	public onAdd(_map: MapInstance): HTMLElement {
		return this.container
	}

	public onRemove(_map: MapInstance): void {
		this.container.remove()
	}

	public getDefaultPosition(): ControlPosition {
		return this.#position
	}
}
