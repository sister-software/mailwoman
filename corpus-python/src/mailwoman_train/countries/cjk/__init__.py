"""The CJK regional grouping, spanning Japan, Korea, Taiwan and the Chinese organizational units.

It is not a country: it carries no `COUNTRY_CODE` and is not in `COUNTRY_MODULES`, because no mail is
addressed to it — `overlay.py` assembles rows several countries produced into the one corpus their
shared head trains on.
"""

from __future__ import annotations
