#!/usr/bin/env python3
"""
Fetch confirmed Bitcoin proofs from calendar servers for any incomplete
.ots files under timestamps/.

Run this ~2–3 days after 'stamp-week.py' so BTC blocks have had time to
confirm (calendars typically aggregate into a BTC tx within 24h, then
wait 1–2 more confirmations before proofs are fully upgradable).

Usage: python3 scripts/upgrade-week.py [--week YYYY-Www] [--install]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TIMESTAMPS_DIR = REPO_ROOT / "timestamps"


def iso_week(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--week", help="ISO week to upgrade (default: last week)")
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()

    if args.install:
        print("[upgrade] installing opentimestamps-client...")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-q", "opentimestamps-client"],
            check=True,
        )

    # Default to last week — stamp runs Sunday, upgrade runs Wednesday
    if args.week:
        week_id = args.week
    else:
        last_sunday = datetime.now(timezone.utc).date() - timedelta(days=3)
        week_id = iso_week(last_sunday)

    print(f"[upgrade] targeting week {week_id}")

    week_dir = TIMESTAMPS_DIR / week_id
    if not week_dir.exists():
        print(f"[upgrade] skip: {week_dir} does not exist yet")
        return 0

    ots_files = list(week_dir.glob("*.ots"))
    if not ots_files:
        print(f"[upgrade] skip: no .ots files in {week_dir}")
        return 0

    any_updated = False
    for ots in sorted(ots_files):
        print(f"[upgrade] fetching confirmations for {ots.name}...")
        cmd = ["ots", "upgrade", str(ots), "--timeout", "120"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            # NOT_UPGRADED_YET is the normal "still pending" case — not an error
            err = result.stderr + result.stdout
            if "NOT_UPGRADED_YET" in err or "still pending" in err.lower():
                print(f"  still pending (calendar hasn't aggregated yet)")
            else:
                print(f"  ERROR (rc={result.returncode}): {err.strip()[:300]}")
            continue

        # ots upgrade modifies the .ots file in-place — size changes tell us
        # if the proof went from incomplete → confirmed
        size = ots.stat().st_size
        print(f"  OK — {size} bytes")
        any_updated = True

    return 0


if __name__ == "__main__":
    sys.exit(main())
