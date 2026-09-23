/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two pieces of host configuration the storage operations depend on, rendered as text so the
 *   interesting part — what goes in the file — is testable without writing to `/etc`.
 */

/**
 * A udev rule that keeps discard enabled on a USB-attached SSD across replugs.
 *
 * The kernel resets `provisioning_mode` to `full` every time the device re-enumerates,
 * and on a bridge that supports UNMAP but not WRITE SAME with unmap that silently disables TRIM.
 * What follows is a drive with no free erase blocks writing at single-digit MB/s,
 * which reads as failing hardware.
 *
 * Measured on the T7 Shield: 2.1 MB/s with 636 ms latency before, 755 MB/s after.
 */
export function renderUdevRule(vendorID: string, productID: string): string {
	return [
		"# Managed by `mwops storage install-udev-rule` — do not edit by hand.",
		"#",
		"# This bridge reports LBPU=1 (UNMAP supported) and LBPWS=0 (no WRITE SAME with unmap).",
		'# The kernel default provisioning_mode of "full" wants the second, so it publishes a',
		"# discard limit of zero and blkdiscard silently does nothing. Without TRIM the controller",
		"# has no free erase blocks and every write becomes read-modify-write.",
		"#",
		"# The mode does not survive a replug, which is why this is a rule and not a one-off write.",
		`ACTION=="add|change", SUBSYSTEM=="scsi_disk", ATTRS{idVendor}=="${vendorID}", ATTRS{idProduct}=="${productID}", ATTR{provisioning_mode}="unmap"`,
		"",
	].join("\n")
}

/**
 * A passwordless-sudo rule for the mwops CLI.
 *
 * Read the caveats before installing this.
 * The rule matches `node <cli> *` — the wildcard is any argument list,
 * so it covers every mwops verb rather than only storage.
 *
 * Anything running as the target user can then take root without a prompt, `cli.ts`
 * and everything it imports join the root trust boundary, and replacing the pinned
 * node binary hands that root to the replacement.
 *
 * Appropriate for a single-user workstation whose operator is already root-capable
 * and drives host commands from scripts.
 * Not appropriate for a shared host, a server, or any account trusted less than root.
 *
 * Nothing needs it: without it, `storage prepare` prompts for a password like any
 * other sudo command, and only an unattended caller is blocked.
 */
export function renderSudoersRule(targetUser: string, nodePath: string, cliPath: string): string {
	return [
		"# Managed by `mwops storage install-sudoers` — do not edit by hand.",
		"# Re-run that operation after upgrading Node or moving the repository: the rule pins both",
		"# absolute paths, and a stale pin falls through to a password prompt rather than failing.",
		`${targetUser} ALL=(root) NOPASSWD: ${nodePath} ${cliPath} *`,
		"",
	].join("\n")
}
