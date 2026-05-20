"""Write run_manifest.json for Mason Jar pipeline run leaves."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping


def write_run_manifest(output_dir: str | Path, payload: Mapping[str, Any]) -> Path:
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    manifest = dict(payload)
    manifest.setdefault("timestamp", datetime.now(timezone.utc).isoformat())
    manifest.setdefault("output_dir", str(out))
    path = out / "run_manifest.json"
    with open(path, "w", encoding="utf-8") as mf:
        json.dump(manifest, mf, indent=2)
    return path
