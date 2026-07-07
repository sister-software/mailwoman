/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Deprecation shim — `mailwoman wof sync` moved. One-minor-version courtesy redirect; remove after.
 */

import { Text } from "ink"
import { useEffect } from "react"

const WofShim = () => {
	useEffect(() => {
		setImmediate(() => process.exit(1))
	}, [])

	return <Text color="yellow">{"`mailwoman wof sync` moved: use `mailwoman gazetteer inspect sync`"}</Text>
}

export default WofShim
