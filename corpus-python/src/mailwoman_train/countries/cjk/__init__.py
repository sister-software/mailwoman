"""The CJK grouping: what spans Japan, Korea, Taiwan and the Chinese organizational units.

This is a region, not a country. It carries no `COUNTRY_CODE` and is not in `COUNTRY_MODULES`,
because nothing addresses mail to it — `overlay.py` assembles rows several countries produced into
the one corpus their shared head trains on.
"""

from __future__ import annotations
