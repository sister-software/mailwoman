"""The Modal launcher stages corpora onto the volume. It starts a GPU run.

The directory is `launch/` and not `modal/` because it imports the `modal` package
shadows it. With no `__init__.py`, `modal/` became a namespace package that won the import, so
`import modal` inside this tree answered a module with `__file__` of None and the SDK was
unreachable even when installed.

This file exists for the same reason: a regular package cannot be silently merged into somebody
else's namespace package the way an implicit one can.
"""

from __future__ import annotations
