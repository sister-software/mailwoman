"""Pre-launch reads of what a run would actually train on.

An audit reports; it never repairs. A number here is what the loader emits, counted at the unit the
model reads, so an audit and the loader disagreeing is a defect in one of them.
"""
