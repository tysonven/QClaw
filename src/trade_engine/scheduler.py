#!/usr/bin/env python3
"""APScheduler instance for the trade engine.

No jobs are registered in Session 1 — the scheduler starts empty and idle.
The cron constants below are the agreed cadence for Session 2's Scanner and
Session 3's Position Monitor; they live here so the schedule is defined in
one place before anything consumes it.

The cadence is asymmetric on purpose: Polymarket resolution activity clusters
early in the week, so Monday is scanned hourly and the weekend every four
hours rather than running a flat interval and burning yfinance calls on quiet
days.
"""

import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

log = logging.getLogger("trade_engine.scheduler")

# Scanner cadence — cron day-of-week: 0=Sun, 1=Mon ... 6=Sat.
SCANNER_CRON_MONDAY = "0 */1 * * 1"
SCANNER_CRON_WEEKDAY = "0 */2 * * 2-5"
SCANNER_CRON_WEEKEND = "0 */4 * * 0,6"

# Position Monitor cadence — matches the current n8n workflow's 15 minutes.
MONITOR_INTERVAL_MINUTES = 15

scheduler = AsyncIOScheduler(timezone="UTC")


def start_scheduler() -> None:
    if scheduler.running:
        log.info("scheduler already running")
        return
    scheduler.start()
    log.info("scheduler started (jobs registered: %d)", len(scheduler.get_jobs()))


def shutdown_scheduler() -> None:
    if not scheduler.running:
        return
    # wait=False: nothing long-running is registered yet, and we do not want
    # shutdown to block PM2's stop timeout once jobs do exist.
    scheduler.shutdown(wait=False)
    log.info("scheduler stopped")


def is_running() -> bool:
    return bool(scheduler.running)
