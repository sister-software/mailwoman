#!/usr/bin/env node

/// <reference types="node" />

import findFreePorts from "find-free-ports"

const MIN_PORT = 20_000
const MAX_PORT = 40_000

/**
 * Finds a free port within the specified range.
 * @param {number} [minPort=20000] The minimum port number to consider.
 * @param {number} [maxPort=40000] The maximum port number to consider.
 * @returns {Promise<number>} A promise that resolves to a free port number.
 */
export async function findDisparatePort(minPort = MIN_PORT, maxPort = MAX_PORT) {
	const startPort = Math.floor(Math.random() * (maxPort - minPort + 1)) + minPort
	const [port] = await findFreePorts(1, { startPort, endPort: maxPort })

	return port
}

if (import.meta.main) {
	process.stdout.write(String(await findDisparatePort()))
}
