// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Reads the resident memory of a process and its descendants from `/proc`.
 *
 * `VmHWM` is the peak resident set size the kernel recorded for the process
 * since it started, and `VmRSS` the current one, both in kibibytes.
 * The descendants are read from `/proc/<pid>/task/<pid>/children`.
 *
 * That file lists the children the process's main thread started.
 * A cluster primary forks its workers from that thread.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"

/**
 * One process's memory reading, or why it couldn't be read.
 */
export type ProcessMemory =
	| { pid: number; read: true; peakKiB: number; residentKiB: number }
	| { pid: number; read: false; error: string }

/**
 * The memory of a process tree, read before the probe stops it.
 */
export interface ProcessTreeMemory {
	processes: ProcessMemory[]
	/**
	 * The sum of every read process's peak, or `null` when any process in the tree was unread,
	 * so a partial sum is never reported as the tree's.
	 */
	totalPeakKiB: number | null
}

const STATUS_FIELD = /^(VmHWM|VmRSS):\s+(\d+)\s+kB$/gmu

async function readProcessMemory(pid: number): Promise<ProcessMemory> {
	let status: string

	try {
		status = await readLocalTextFile(`/proc/${pid}/status`)
	} catch (error) {
		return { pid, read: false, error: error instanceof Error ? error.message : String(error) }
	}

	const fields = new Map([...status.matchAll(STATUS_FIELD)].map((match) => [match[1], Number(match[2])]))
	const peakKiB = fields.get("VmHWM")
	const residentKiB = fields.get("VmRSS")

	if (typeof peakKiB !== "number" || typeof residentKiB !== "number") {
		return { pid, read: false, error: `/proc/${pid}/status holds no VmHWM and VmRSS lines` }
	}

	return { pid, read: true, peakKiB, residentKiB }
}

/**
 * The process ids of every descendant of `pid`, depth first.
 *
 * A process whose children file can't be read contributes none, because it has exited.
 */
export async function readDescendants(pid: number): Promise<number[]> {
	let text: string

	try {
		text = await readLocalTextFile(`/proc/${pid}/task/${pid}/children`)
	} catch {
		return []
	}

	const children = text
		.trim()
		.split(/\s+/u)
		.filter((field) => field.length)
		.map(Number)

	const descendants: number[] = []

	for (const child of children) {
		descendants.push(child, ...(await readDescendants(child)))
	}

	return descendants
}

/**
 * Read the memory of `pid` and each of its descendants.
 */
export async function readProcessTreeMemory(pid: number): Promise<ProcessTreeMemory> {
	const pids = [pid, ...(await readDescendants(pid))]
	const processes = await Promise.all(pids.map(readProcessMemory))

	const totalPeakKiB = processes.every((entry) => entry.read)
		? processes.reduce((sum, entry) => sum + (entry.read ? entry.peakKiB : 0), 0)
		: null

	return { processes, totalPeakKiB }
}
