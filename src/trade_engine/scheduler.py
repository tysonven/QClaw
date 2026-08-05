#!/usr/bin/env python3
"""APScheduler instance for the trade engine.

Session 6 registers four jobs: three scanner crons plus the position monitor
interval. The job FUNCTIONS live in main.py (they need the process-wide
approval gate and executor singletons, and importing them here would be
circular); register_jobs() takes them as arguments so the schedule itself
stays defined in one place.

The cadence is asymmetric on purpose: Polymarket resolution activity clusters
early in the week, so Monday is scanned hourly and the weekend every four
hours rather than running a flat interval and burning yfinance calls on quiet
days.
"""

import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

log = logging.getLogger("trade_engine.scheduler")

# Scanner cadence, as CronTrigger kwargs. NAMED days only: APScheduler numbers
# day_of_week 0=Monday, standard cron numbers 0=Sunday, and
# CronTrigger.from_crontab does NOT translate between them (verified against
# APScheduler 3.11.3: "0 */4 * * 0,6" parses as Monday+Sunday, not
# Saturday+Sunday). The earlier crontab-string constants were one silent
# day-shift away from scanning the wrong days; names are unambiguous.
SCANNER_CRON_MONDAY = {"day_of_week": "mon", "hour": "*/1", "minute": "0"}
SCANNER_CRON_WEEKDAY = {"day_of_week": "tue-fri", "hour": "*/2", "minute": "0"}
SCANNER_CRON_WEEKEND = {"day_of_week": "sat,sun", "hour": "*/4", "minute": "0"}

# Position Monitor cadence — matches the n8n workflow's 15 minutes.
MONITOR_INTERVAL_MINUTES = 15

scheduler = AsyncIOScheduler(timezone="UTC")


def register_jobs(scan_job, monitor_job) -> None:
    """Register the four Session 6 jobs. Idempotent via replace_existing.

    max_instances=1 everywhere: a scan can block up to 30 minutes on the
    approval gate, and overlapping sweeps would double-close positions.
    coalesce=True collapses a missed-fire backlog into one run.
    """
    for job_id, cron in (
        ("scanner_monday", SCANNER_CRON_MONDAY),
        ("scanner_weekday", SCANNER_CRON_WEEKDAY),
        ("scanner_weekend", SCANNER_CRON_WEEKEND),
    ):
        scheduler.add_job(
            scan_job,
            CronTrigger(**cron, timezone="UTC"),
            id=job_id,
            replace_existing=True,
            coalesce=True,
            max_instances=1,
            misfire_grace_time=300,
        )
    scheduler.add_job(
        monitor_job,
        IntervalTrigger(minutes=MONITOR_INTERVAL_MINUTES),
        id="position_monitor",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
        misfire_grace_time=120,
    )
    log.info(
        "registered %d scheduler jobs: %s",
        len(scheduler.get_jobs()),
        ", ".join(j.id for j in scheduler.get_jobs()),
    )


def job_count() -> int:
    return len(scheduler.get_jobs())


def next_scan_time():
    """Earliest next fire time across the three scanner cron jobs, or None.

    The three jobs partition the week, so "when does the scanner run next"
    is the minimum of their next_run_time values, not any single job's.
    None before the scheduler starts (next_run_time is unset until then).
    """
    times = [
        job.next_run_time
        for job in scheduler.get_jobs()
        if job.id.startswith("scanner_") and job.next_run_time is not None
    ]
    return min(times) if times else None


def start_scheduler() -> None:
    if scheduler.running:
        log.info("scheduler already running")
        return
    scheduler.start()
    log.info("scheduler started (jobs registered: %d)", len(scheduler.get_jobs()))


def shutdown_scheduler() -> None:
    if not scheduler.running:
        return
    # wait=False: a scan job can hold the approval gate open for 30 minutes,
    # and shutdown must not block PM2's stop timeout on it.
    scheduler.shutdown(wait=False)
    log.info("scheduler stopped")


def is_running() -> bool:
    return bool(scheduler.running)
