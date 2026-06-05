# Lab network sharing (Mason Jar)

Mason Jar on a shared Windows compute server can saturate the NIC when many users run pipeline jobs against NAS-backed projects. Mason Jar **v3.2+** includes cooperative **adaptive bandwidth fair-share** so active pipeline jobs split available link capacity instead of one instance consuming 100%.

## What Mason Jar does (client-side)

- Tracks active heavy Python jobs machine-wide via `%ProgramData%\MasonJar\io-fairshare\registry\` (Windows).
- Each job’s NAS I/O is throttled to roughly `(link speed × 85% headroom) / number of active jobs`.
- When fewer jobs run, each job gets more bandwidth automatically.
- Files ≤256 KB skip throttling (project JSON, small metadata).
- Toggle and link-speed override: Start hub → **Network sharing**.

All lab members should run the same Mason Jar version for fair-share to apply to every instance.

## What the OS does not do

Windows and macOS do **not** fairly divide SMB file I/O between apps or RDP sessions. Mason Jar’s limiter is app-level, not a replacement for network infrastructure.

## Optional IT-level complements

These help the whole lab but are outside the Mason Jar installer:

- **Switch or NAS QoS** — prioritize or cap SMB traffic per VLAN/subnet.
- **Dedicated storage network** — separate NIC/VLAN for NAS vs internet.
- **NAS connection limits** — some appliances expose per-client throughput caps.

## Tuning on your compute server

1. Open Mason Jar on the server → **Network sharing**.
2. If auto-detect picks the wrong adapter, set **Manual link speed** to your NAS NIC (e.g. 1000 Mbps for 1 GbE).
3. Ensure `%ProgramData%\MasonJar\io-fairshare\` is writable by all RDP users (default on domain servers; IT may need to grant Modify on first deploy).

Shared `config.json` in that folder can set machine-wide defaults (headroom, min Mbps per job) for all users.
