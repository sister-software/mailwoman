/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * A udev rule that keeps discard enabled on a USB-attached SSD across replugs.
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
 * The wildcard matches any argument list, so anything running as the target user can take root without a prompt.
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
