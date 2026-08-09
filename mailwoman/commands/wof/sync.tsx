// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Deprecation shim — `mailwoman wof sync` moved. One-minor-version courtesy redirect; remove after.
 */

import { Text } from "ink"
import { useCommandTask } from "mailwoman/cli-kit"

const WofShim = () => {
	useCommandTask(
		async () => {},
		() => 1
	)

	return <Text color="yellow">{"`mailwoman wof sync` moved: use `mailwoman gazetteer inspect sync`"}</Text>
}

export default WofShim
