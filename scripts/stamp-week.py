#!/usr/bin/env python3
"""
Aggregate this week's Pulse UIDs into a single week file and stamp with
OpenTimestamps (BTC 主网 calendar servers).

Usage: python3 scripts/stamp-week.py [--week YYYY-Www] [--dry-run]

Default: stamps the ISO week containing today's date (UTC).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
PULSES_DIR = REPO_ROOT / "pulses"
TIMESTAMPS_DIR = REPO_ROOT / "timestamps"

# OpenTimestamps default calendars — 4 个免费的、社区捐赠的 calendar
CALENDARS = [
    "https://alice.btc.calendar.opentimestamps.org",
    "https://bob.btc.calendar.opentimestamps.org",
    "https://finney.calendar.eternitywall.com",
    "https://ots.btc.catallaxy.com",
]


def iso_week(d: date) -> str:
    """ISO week identifier like '2026-W47'."""
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def week_range(week_id: str) -> tuple[date, date]:
    """Return the (Monday, Sunday) date range for a given ISO week ID."""
    y_str, _, w_str = week_id.partition("-W")
    y, w = int(y_str), int(w_str)
    # ISO week 1 is the week containing January 4; its first day is Monday.
    # Starting from January 1 and adjusting by its weekday is off by one for
    # some years, which can exclude every Monday pulse from the weekly stamp.
    jan4 = date(y, 1, 4)
    first_monday = jan4 - timedelta(days=jan4.weekday())
    monday = first_monday + timedelta(weeks=w - 1)
    sunday = monday + timedelta(days=6)
    return monday, sunday


def collect_weekly_uids(week_id: str) -> list[tuple[str, str]]:
    """
    Walk pulses/ and return (uid, relative_path) for all pulses whose
    evaluatedAt timestamp falls within the given ISO week (UTC).
    """
    monday, sunday = week_range(week_id)
    next_monday = date.fromordinal(sunday.toordinal() + 1)

    results: list[tuple[str, str]] = []
    if not PULSES_DIR.exists():
        print(f"[stamp] WARNING: {PULSES_DIR} does not exist yet (no pulses collected?)")
        return results

    for json_path in sorted(PULSES_DIR.rglob("*.json")):
        try:
            data = json.loads(json_path.read_text())
        except (json.JSONDecodeError, OSError):
            continue

        uid = data.get("uid")
        evaluated_at = data.get("data", {}).get("evaluatedAt")
        if not uid or not evaluated_at:
            continue

        # Convert unix seconds → date in UTC
        eval_date = datetime.fromtimestamp(int(evaluated_at), tz=timezone.utc).date()
        if monday <= eval_date < next_monday:
            rel = str(json_path.relative_to(REPO_ROOT))
            results.append((uid, rel))

    # Sort by uid for determinism
    results.sort(key=lambda x: x[0])
    return results


def run_ots_stamp(week_file: Path, dry_run: bool = False) -> bool:
    """Run 'ots stamp' on the week file, outputting week_file.ots."""
    ots_path = week_file.with_suffix(week_file.suffix + ".ots")

    if dry_run:
        print(f"[stamp] DRY-RUN: would run 'ots stamp {week_file}'")
        # Touch a placeholder so we can still see the file in git
        ots_path.write_bytes(b"PLACEHOLDER (dry-run)")
        return True

    # Build calendar args: --calendar URL for each
    cal_args = []
    for c in CALENDARS:
        cal_args.extend(["--calendar", c])

    cmd = ["ots", "stamp", str(week_file)] + cal_args + ["--timeout", "120"]
    print(f"[stamp] running: {' '.join(cmd)}")

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[stamp] ERROR (rc={result.returncode}):")
        print(f"  stdout: {result.stdout}")
        print(f"  stderr: {result.stderr}")
        return False

    print(f"[stamp] OK — {ots_path.name} created")
    if result.stdout:
        print(f"  {result.stdout.strip()}")
    return True


def emit_github_outputs(week_id: str, count: int, week_file: Path, ots_file: Path) -> None:
    """Write to $GITHUB_OUTPUT so the workflow can use these values."""
    outputs = {
        "week": week_id,
        "pulse_count": str(count),
        "week_file": str(week_file.relative_to(REPO_ROOT)),
        "ots_file": str(ots_file.relative_to(REPO_ROOT)),
    }
    print("---GH_OUTPUT---")
    for k, v in outputs.items():
        print(f"{k}={v}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            for k, v in outputs.items():
                f.write(f"{k}={v}\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--week", help="ISO week like 2026-W47 (default: this week)")
    parser.add_argument("--dry-run", action="store_true", help="Don't actually submit to calendars")
    parser.add_argument("--install", action="store_true", help="Install opentimestamps-client via pip first")
    args = parser.parse_args()

    if args.install:
        print("[stamp] installing opentimestamps-client...")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-q", "opentimestamps-client"],
            check=True,
        )

    week_id = args.week or iso_week(datetime.now(timezone.utc).date())
    monday, sunday = week_range(week_id)
    print(f"[stamp] week={week_id} ({monday} → {sunday}) UTC")

    # 1. Collect UIDs
    entries = collect_weekly_uids(week_id)
    if not entries:
        print("[stamp] FATAL: no pulses found for this week — nothing to stamp")
        return 1

    print(f"[stamp] {len(entries)} pulses in week {week_id}")

    # 2. Create week directory + week.txt
    week_dir = TIMESTAMPS_DIR / week_id
    week_dir.mkdir(parents=True, exist_ok=True)
    week_file = week_dir / "week.txt"
    week_file.write_text("\n".join(uid for uid, _ in entries) + "\n")

    # 3. Create manifest.json
    manifest = {
        "week": week_id,
        "monday": monday.isoformat(),
        "sunday": sunday.isoformat(),
        "stampedAt": datetime.now(timezone.utc).isoformat(),
        "pulseCount": len(entries),
        "calendars": CALENDARS,
        "uids": [
            {"uid": uid, "pulse": pulse_path}
            for uid, pulse_path in entries
        ],
    }
    manifest_path = week_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))

    # 4. OTS stamp
    print(f"[stamp] week.txt = {week_file} ({week_file.stat().st_size} bytes)")
    ok = run_ots_stamp(week_file, dry_run=args.dry_run)
    if not ok and not args.dry_run:
        return 1

    ots_file = week_file.with_suffix(week_file.suffix + ".ots")
    emit_github_outputs(week_id, len(entries), week_file, ots_file)

    # 5. Print verification hint for humans
    print(f"""
[stamp] === WEEK {week_id} STAMPED ===
  Pulses stamped:  {len(entries)}
  week.txt:        {week_file.relative_to(REPO_ROOT)}
  week.txt.ots:    {ots_file.relative_to(REPO_ROOT)}
  manifest:        {manifest_path.relative_to(REPO_ROOT)}

  Upgrade (fetch BTC confirmation):
    ots upgrade {ots_file.relative_to(REPO_ROOT)}

  Verify locally (after upgrade produces a confirmed proof):
    ots verify {ots_file.relative_to(REPO_ROOT)} {week_file.relative_to(REPO_ROOT)}

  Online verify (opentimestamps.org):
    Drag {ots_file.relative_to(REPO_ROOT)} into the web stamper.
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
