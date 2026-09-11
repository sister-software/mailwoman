/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Device-location map bias.
 */

import { useCallback, useRef, useState, type RefObject } from "react"

/**
 * Device-location proximity-bias control (the "📍 Use my location" button state + toggle).
 */
export interface GeoBiasControl {
	/**
	 * Whether a device location is currently applied as a soft bias.
	 */
	active: boolean
	/**
	 * Toggle the device-location bias on/off (prompts for geolocation when turning on).
	 */
	toggle: () => void
}

export interface GeoBiasState extends GeoBiasControl {
	locationRef: RefObject<{ lat: number; lon: number } | null>
}

export function useGeoBias(): GeoBiasState {
	const geoBiasRef = useRef<{ lat: number; lon: number } | null>(null)
	const [active, setActive] = useState(false)

	const toggle = useCallback(() => {
		if (geoBiasRef.current) {
			geoBiasRef.current = null
			setActive(false)

			return
		}

		if (typeof navigator === "undefined" || !navigator.geolocation) return

		navigator.geolocation.getCurrentPosition(
			(position) => {
				geoBiasRef.current = { lat: position.coords.latitude, lon: position.coords.longitude }
				setActive(true)
			},
			() => setActive(false),
			{ maximumAge: 600_000, timeout: 8000 }
		)
	}, [])

	return { active, toggle, locationRef: geoBiasRef }
}
