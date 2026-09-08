#!/usr/bin/env python3
"""Horizon arithmetic shared by the scanner and the executor.

Its own module because `scanner.py` imports `executor.py`, so the executor
cannot import the scanner back without a cycle, and the alternative to sharing
is two copies of a date parser on the money path.

The split in behaviour is deliberate and is the point of the module:

  `horizon_days()` returns None when the end date is absent or unparseable.
  It NEVER substitutes a default, because the two callers need opposite things
  from that case. The scanner treats an unknown end date as a 30-day market and
  carries on; executor GATE 7 refuses. A shared function that picked either one
  would be wrong for the other caller, so it returns None and each decides.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Optional


def parse_end_date(end_date: Any) -> Optional[datetime]:
    """Parse a Gamma endDate into an aware UTC datetime, or None.

    Accepts the trailing-Z form Gamma actually sends. A naive timestamp is
    treated as UTC, matching how the scanner has always read these and how both
    hosts are configured.
    """
    if not end_date:
        return None
    if isinstance(end_date, datetime):
        parsed = end_date
    else:
        try:
            parsed = datetime.fromisoformat(str(end_date).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def horizon_days(end_date: Any, now: datetime) -> Optional[float]:
    """Exact fractional days from `now` until `end_date`. None if unusable.

    None means "cannot be determined", not "zero" and not "far away". Callers
    must decide what that means for them; see the module docstring.

    May be negative for a market that has already resolved. That is a real
    answer rather than an error, and both callers reject it on the same
    comparison they use for a short horizon.
    """
    parsed = parse_end_date(end_date)
    if parsed is None:
        return None
    value = (parsed - now).total_seconds() / 86400.0
    return value if math.isfinite(value) else None
