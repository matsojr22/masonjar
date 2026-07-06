# Handoff: Nonpaged `Proc` pool leak / multi-day server death (KIM-SERVER)

**Date of investigation:** 2026-07-03 → 2026-07-04 (PT)  
**Host:** `KIM-SERVER` (Puget Rackstation, Ryzen 9 7950X, 32 logical CPUs, **127 GB RAM**, Windows 11 Pro 10.0.22621)  
**Constraint:** Lab uses Mason Jar **24/7/365** with **no alternate machine**. A reboot is extremely expensive: operator must **drive ~600 miles** to power the server back on correctly. **Do not plan idle experiments, multi-day downtime, or casual reboots.** Prefer live instrumentation and incremental app fixes; treat reboot as a last-resort, scheduled event.

**Hard rule (Mason Jar-only fix):** The Proc leak remediation is **100% in-app**. **Never** install, bundle, integrate, upgrade, unload, or recommend **Sentinel LDK / HASP / FlexNet** (or any third-party commercial license stack) as part of this project. Kernel filters observed on KIM-SERVER during poolmon are **environmental context only**—not an actionable remediation path for Mason Jar agents. If fixes in Mason Jar are insufficient, the only acceptable follow-up is **more Mason Jar hardening** (see §5 Phase F), not third-party software.

**Related product docs:** [`AGENTS.md`](../AGENTS.md), [`docs/AGENT_HANDOFF.md`](AGENT_HANDOFF.md)  
**Measurement script (added this session):** [`scripts/pool_leak_watch.ps1`](../scripts/pool_leak_watch.ps1)

### Post-reboot baseline (2026-07-04, ~0.3 h uptime)

| Metric | Value |
|--------|------:|
| NonpagedGB | 0.857 |
| Proc_MB | **5.8–5.9** |
| Proc outstanding | ~1650–1670 |
| Proc allocs / frees | ~1670 / **1** → free% **~0.06%** |
| Processes / handles | ~260 / ~119k |

Hourly CSV: `%USERPROFILE%\.masonjar\pool_leak_watch.csv` (background `pool_leak_watch.ps1 -IntervalSec 3600 -Samples 336`). Leak signature already present at low absolute size; pre-reboot bad reference was **Proc_MB≈1050**, frees=29 at ~106 h.

---

## 1. Executive summary

KIM-SERVER becomes unusable after **several days to about a week** of uptime: UI lag (typing not keeping up), global slowdown, even when Task Manager looks “idle.” Operators reboot to recover.

Root symptom in the kernel:

| Metric (late in ~106 h uptime) | Value |
|--------------------------------|------:|
| Nonpaged pool | **~3.8 GB** |
| **`Proc` tag (process objects, `nt!ps`)** | **~1.05–1.06 GB** |
| `Proc` outstanding | **~298k–301k** |
| `Proc` allocs / frees | **~300k / 29** → **free rate ~0.01%** |
| Live processes | **~280–430** |

Almost every process that has **started and exited since boot** leaves an `EPROCESS` behind. Something still holds a kernel reference/handle. **Signing users out, killing Python jobs, and finishing heavy work do not free `Proc`.** Only a **reboot** clears the stuck pool.

Mason Jar / Bell Jar are the lab’s primary long-running apps and **major process spawners** (one `PythonShell` / `child_process.spawn` per job, plus Electron). **Fix the app:** v6.0.12+ routes headless tools through a supervised long-lived Python worker and guarantees job cleanup on quit. Third-party kernel minifilters (e.g. `aksdf.sys` on `\Device\Mup`) were noted during investigation as possible reference-holders on the host—they are **not** something Mason Jar agents may change. Direct Electron / Python lifecycle leaks must still be fixed in-app.

**Acute lag** during investigation was separately dominated by live jobs (`find_neurons.py` on `Z:` at **100k–700k page faults/sec**, `System` process ~120% CPU). That is workload, not the chronic `Proc` leak—but both matter on this host.

---

## 2. Environment snapshot (at investigation)

- **Uptime when measured:** ~106 hours (boot **2026-06-29 13:50** PT).
- **RDP users (early):** `John` session 4 (idle 1+ day, logged in since 6/29), `Matt` session 5. Later John signed out; Matt alone.
- **RAM accounting (Matt alone, before/during detect):**
  - Task Manager “in use” **~40–44 GB**
  - Sum of process working sets often **~13–18 GB**
  - Gap = kernel pools + active mappings + jobs with large **private** bytes but smaller working sets
- **Hyper-V:** **0 VMs**; only Default Switch + WSL switch; WSL Ubuntu **Stopped**. Not the memory problem.
- **Local disk / CPU at idle samples:** disk ~idle; CPU often ~8–10% **except** when Python detect was faulting (then `System` + `python` dominated).
- **Network:** Intel I226-V 1 Gbps; lab data on **`Z:`** (NAS).

### Host environment (context only — not Mason Jar remediation)

Filters and services present during poolmon on KIM-SERVER (document for correlation; **do not install or upgrade third-party license stacks as a Mason Jar fix**):

| Component | Detail |
|-----------|--------|
| **`aksdf.sys`** | Third-party minifilter v1.52, **2020-05-29**; on **C:, D:, shadows, `\Device\Mup`** |
| **`dbx.sys`** | Dropbox filter |
| **AMD `amdkmdag`** | 31.0.24002.92 |
| **NVIDIA `nvlddmkm`** | 31.0.15.3742 (2023-09) |
| VirtualBox / VirtualHere drivers | Present |

### Pool tags (nonpaged) — leak signature

| Tag | ~MB | Outstanding | Notes |
|-----|----:|------------:|-------|
| **Proc** | **1050+** | **~300k** | **allocs≈300k, frees=29** — primary leak |
| **MiP2** | ~186 | **~300k** | Tracks Proc 1:1 |
| **PsIn** | ~63 | **~300k** | High churn but same outstanding band |
| FMsc | ~202 | ~83k | Filter Manager section contexts |
| File | ~171 | ~474k | File objects; high churn (NAS) |
| NxRx, cxbm, sshl | 95 / 82 / 68 | never-freed pattern (`frees=0`) | Secondary; identify if time allows |
| sm* (SMB) | ~170 combined | — | NAS redirector |
| NVRM | ~25–37 | — | NVIDIA; modest |

**Paged pool (secondary):** `Toke` ~527 MB (token objects)—often rises with process/session churn.

---

## 3. Findings (with evidence)

### 3.1 Chronic failure mode = stuck `Proc`, not “mystery RAM”

- Process working-set sum **does not** explain Task Manager “in use” alone; **nonpaged `Proc` ~1 GB** is invisible in normal user process lists.
- After John logged out, session rollup showed only Matt + services, but **`Proc` did not drop**.
- After heavy `find_neurons` / watch scripts exited or were killed, **`Proc` still ~1064 MB, frees still 29**.
- **Conclusion:** stuck allocations **cannot be cleared without reboot**. User-mode kills only **stop further growth** and acute fault storms.

### 3.2 Acute lag during session ≠ only the leak

While `find_neurons.py` ran on `Z:\Matt Jacobs\masonjar_projects\M465_...`:

- Page faults **140k–740k/sec**, almost all `python`
- Private bytes **~9 GB**, working set **~5 GB**
- `System` process **~120%+** CPU (memory manager + SMB)

Also present: `scripts/m465_align_repro_watch.py` (dev repro watcher, **~2 GB private**)—killed during investigation; **do not leave running on the lab server**.

### 3.3 Mason Jar / Bell Jar as leak **feeders**

Architecture (see `AGENTS.md`): Electron main spawns **short-lived Python per tool** via `python-shell`.

**Spawn sites:**

| Location | Pattern |
|----------|---------|
| `src/main.ts` | **15+** `new PythonShell(...)` IPC handlers (max, align, adjust, detect, CZI, …) |
| `src/batch_queue.ts` | Same per batch job |
| `js/file_index.js` | Renderer `child_process.spawn` → `index_metadata.py` (batches of 40) |
| `js/preprocess_wizard.js` | Renderer `spawn` for dimension probe |

Lifecycle smell: many handlers finalize primarily on stdout **`"Done!"`** then `pyshell.end(...)`. Newer paths (batch, tissue cleanup, CZI) have `close` safety nets; older ones are inconsistent. **No single process supervisor**; no guaranteed stdio destroy / listener teardown / active-job map on quit.

**Mechanism we own:** Mason Jar maximized intentional Python process churn on a multi-user RDP box (one OS process per tool). v6.0.12+ reduces that churn via [`src/python_job.ts`](../src/python_job.ts) + [`py/masonjar_worker.py`](../py/masonjar_worker.py). Remaining shells: Align/Adjust GUI only.

**Mechanism we do not own:** host kernel filters may also observe process create/exit; Mason Jar agents **must not** modify them. Success is measured by whether **Mason Jar job churn drops** (`python_jobs.ndjson`) and **system** `Proc` slope improves after worker release adoption.

### 3.4 Hyper-V / WSL

Elevated `Get-VM`: **0 VMs**. Irrelevant to this incident.

### 3.5 What does **not** reclaim `Proc` without reboot

| Attempted / observed | Result |
|----------------------|--------|
| RDP sign-out (John) | No `Proc` drop |
| Process exit (detect finished) | No `Proc` drop |
| `Stop-Process` on align repro watch | No reclaim of stuck pool |
| Standby/cache trim (theoretical) | Frees **available** cache only, not `Proc` |
There is **no** supported API to flush nonpaged `Proc` tags. Mason Jar agents **must not** stop, unload, or upgrade third-party license drivers on the host.

---

## 4. Operational constraints for the next agent

1. **No “stop the lab for N hours” experiments.** Server is production 24/7.
2. **No casual reboot.** Operator must travel **~600 miles** to power on correctly. Reboot only when:
   - Machine is already unusable, or
   - A planned maintenance window is explicitly scheduled by Matt, or
   - A fix is ready and a single reboot is required to load drivers / clear pool **and** Matt has approved travel/time.
3. Prefer **live** metrics: hourly `pool_leak_watch` CSV + Mason Jar job logs under normal load.
4. Ship app changes **behind flags** where behavior changes; keep old `PythonShell` path until worker is proven.
5. Do not leave **dev scripts** (`scripts/m465_*`) running on KIM-SERVER.
6. **Mixed fleet is permanent.** Other RDP users will keep using **prior release builds** from their own profiles indefinitely. Tests must **never** assume all instances can be moved to dev/worker, that release can be uninstalled lab-wide, or that “clean all-dev” windows are achievable. Measure **system-wide** `Proc` under normal multi-user mixed load; treat worker adoption as incremental (per user/session), not a gate for reading the CSV.

---

## 5. Plan (live-safe)

### Phase A — Observe on live workload (no downtime)

1. Run or schedule:
   ```text
   powershell -NoProfile -File scripts\pool_leak_watch.ps1 -IntervalSec 3600 -Samples 168
   ```
   (or Task Scheduler hourly → append CSV under `~/.masonjar/` or `%ProgramData%\MasonJar\`).
2. Add **job lifecycle logging** in Electron (see Phase B): every Python job `start/end`, script, PID, exit code → `~/.masonjar/python_jobs.ndjson`.
3. Correlate **ΔProc_allocs** with job starts over normal days (no idle arm).

**Success signal for “app feeds leak”:** `Proc_allocs` rises in step with Mason Jar job activity / multi-user sessions.

### Phase B — Process supervisor (fix direct handle leaks; reduce abandon paths)

Implement something like `src/python_job.ts` (name flexible) used by `main.ts` + `batch_queue.ts`:

- Single API: `runPythonJob({ script, args, env, killChannel, onLine, onDone })`
- Always finalize on child **`close`/`exit`**, not only `"Done!"`
- On finish: kill if needed → destroy stdio → remove listeners → remove kill IPC → fairshare `release()` → drop references
- `Map` of active jobs; **`before-quit`**: kill and wait for all
- **Move renderer spawns** (`js/file_index.js`, `js/preprocess_wizard.js`) to **main-process IPC** through the same supervisor
- Log each job to `~/.masonjar/python_jobs.ndjson` (and optional debug ingest if still in a debug session)

**Success (live, mixed fleet):** after a **worker release** is available, compare CSV segments as release share drops over weeks/months—not as a controlled A/B. Goal: lower system `ΔProc_out/day` and/or higher `Proc_free%` vs bad-boot reference (~2.8k/h). Worker build on **some** sessions must help even while **other** sessions still run old release.

### Phase C — Long-lived Python worker (root app fix for process churn)

Today: one OS process per tool. Target: **one worker per app session**.

- `python/src/belljar/` already has JSON-RPC **`belljar server`** (not wired to Electron)—prefer extending that or a thin `py/masonjar_worker.py` that dispatches existing `py/*.py` entrypoints **in-process**.
- Feature flag e.g. `MASONJAR_PYTHON_WORKER=1` or `masonjar.pythonWorker` in settings.
- Roll out **per tool** (max → intensity → detect → …); batch uses same worker.
- Align/Adjust: remain separate GUI processes but **registered** with the supervisor (tracked PID, guaranteed cleanup on Finish/Cancel/quit).
- Torch/SAHI: force **0 dataloader workers** on Electron path if any appear.

**Success:** under normal **multi-user mixed fleet**, `Proc_MB` growth slows materially after worker release adoption (not “stays tens of MB for days” in isolation—other users on old release still contribute). `Proc_free%` not stuck at ~0.01% is the stronger signal when fixes work.

### Phase D — Shipped: v6.0.12 worker release

**Status:** Released 2026-07-05 — [v6.0.12](https://github.com/matsojr22/masonjar/releases/tag/v6.0.12).

- Headless tools → long-lived worker (default on; `MASONJAR_PYTHON_WORKER=0` escape hatch).
- Align/Adjust → supervised one-shot shells (`forceShell`).
- Job log → `~/.masonjar/python_jobs.ndjson` (`via`, `build`, `gui`).

**Deploy verification:** [`scripts/verify_release_worker.ps1`](../scripts/verify_release_worker.ps1) after install.

**7-day gate:** [`scripts/start_7d_uptime_gate.ps1`](../scripts/start_7d_uptime_gate.ps1) → hourly CSV → [`scripts/correlate_proc_retest.ps1`](../scripts/correlate_proc_retest.ps1).

### Phase F — Further in-app hardening (if 7-day gate fails)

Only Mason Jar code changes—**never** third-party license/driver installs:

| Source | Hardening |
|--------|-----------|
| Align / Adjust | Guaranteed `kill()` on all finalize paths; orphan PID log |
| Detect / SAHI | `torch.set_num_threads(1)` + no subprocess workers in Electron path |
| Multiple RDP users | N workers expected; optional future shared worker across instances |
| Legacy Bell Jar / old release | Mixed fleet permanent; measure system-wide CSV |

Ship fixes as **6.0.13+** releases; re-run 7-day gate after each material change.

### Phase E — Reboot policy (given 600-mile cost)

| When | Action |
|------|--------|
| Machine already dead / unusable | Reboot is unavoidable; clear `Proc`; install latest Mason Jar build **before** or **immediately after** so the next uptime benefits |
| Fix ready (supervisor and/or worker) | Schedule **one** trip/reboot; verify `pool_leak_watch` day 1 and day 4 |
| Machine degraded but usable | Prefer Phase B/C deploys **without** reboot (Electron update only); reboot only if pool already ~1 GB+ and UI is failing |

**Post-reboot checklist (for whoever is on-site):**

1. `pool_leak_watch.ps1` baseline within minutes of login.
2. Confirm no `scripts/m465_*` watchers auto-started.
3. Deploy latest Mason Jar worker release if not already installed.
4. Start hourly pool CSV: `scripts/start_pool_leak_watch.ps1` or `scripts/start_7d_uptime_gate.ps1`
5. Lab resumes immediately.

#### Planned maintenance window (single trip — Matt schedules)

Combine when UI fails or fixes are ready:

| Step | Action |
|------|--------|
| 1 | On-site power cycle (600-mile trip) when unavoidable |
| 2 | Deploy Mason Jar worker release (≥6.0.12 zip from GitHub releases) |
| 3 | `scripts/verify_release_worker.ps1` — confirm `via: worker` in job log |
| 4 | `scripts/start_7d_uptime_gate.ps1` — t0 marker + hourly CSV |
| 5 | Day 7: `scripts/correlate_proc_retest.ps1` — pass/fail vs ~2.8k/h baseline |

**Packaged release:** Ship worker in next release; users adopt incrementally from their profiles. Agent cuts `node scripts/build-release.js --windows-only` when ready—mixed fleet during rollout is expected.

---

## 6. TODO for the next agent

### Must do (product)

- [x] **B1.** Add `src/python_job.ts` (or equivalent) supervisor; migrate all `PythonShell` sites in `src/main.ts` and `src/batch_queue.ts`.
- [x] **B2.** Job NDJSON log: `~/.masonjar/python_jobs.ndjson` (start/end/pid/script/code).
- [x] **B3.** Remove renderer `child_process.spawn` from `js/file_index.js` and `js/preprocess_wizard.js`; IPC to main supervisor.
- [x] **B4.** `before-quit` / `will-quit`: drain active jobs.
- [x] **B5.** Compile `src/main.ts` → commit `main.js` per repo rules.
- [x] **C1.** Design long-lived worker protocol (reuse `belljar server` if fit).
- [x] **C2.** Flag-gated worker for 1–2 tools; measure with `pool_leak_watch.ps1`. **Gate: FAIL** at 37.7 h (see §8).
- [x] **C3.** Port remaining tools + batch; keep Align/Adjust supervised but separate.
- [x] **C4.** Snapshot marker recorded (`proc_retest_t0.json`); mixed fleet remains the norm.
- [ ] **C6.** After **worker release** ships: compare **system** pool CSV week-over-week as users adopt (mixed fleet OK). No all-dev gate.
- [x] **C5.** Align/Adjust `forceShell` lifecycle hardening (`killChannel`, `onKill`, `build`/`gui` tags in job log).

### Must do (ops / measurement)

- [x] **A1.** Ensure hourly (or continuous) `pool_leak_watch` CSV on KIM-SERVER without interrupting users.
- [x] **A2.** Document baseline from **this** boot: `Proc_MB≈1050+`, `frees=29`, `free%≈0.01%` at ~106 h—use as “bad” reference until next reboot.
- [x] **A3.** After any future reboot, capture day-0 / day-1 / day-4 pool samples into the same CSV scheme.
- [x] **A4.** Phase C gate sample at 37.7 h documented (§8); continue hourly CSV to ~106 h on current uptime.
- [x] **A5.** Fleet columns in pool CSV (`MasonJar_dev`, `MasonJar_release`, `Python_worker`, `Python_shell`).

### Do not do

- [ ] Idle-only or “stop Mason Jar for hours” causality tests.
- [ ] Install, upgrade, unload, or recommend **Sentinel LDK / HASP / FlexNet** for any reason in this project.
- [ ] Assume Hyper-V VMs are involved (already verified empty).
- [ ] Leave `m465_align_repro_watch.py` or similar running on the server.
- [ ] Claim `Proc` can be cleared without reboot (disproven).

### Optional / later

- [ ] Identify pool tags `NxRx`, `cxbm`, `sshl` (never-freed) via `pooltag.txt` / driver string search.
- [ ] If worker release does not improve `free%` after 7-day gate: ship **Phase F** in-app hardening (6.0.13+), not third-party software.
- [ ] Consider scheduled **pool alert** (email/log when `Proc_MB` > 200 or `free%` < 1 after 24 h uptime)—alert only, no auto-reboot.

---

## 7. Commands cheat sheet

```powershell
# One-shot pool snapshot (includes fleet counts)
powershell -NoProfile -File C:\Users\Matt\git\masonjar\scripts\pool_leak_watch.ps1

# Hourly samples — appends to ~/.masonjar/pool_leak_watch.csv
powershell -NoProfile -File C:\Users\Matt\git\masonjar\scripts\pool_leak_watch.ps1 -IntervalSec 3600 -Samples 336

# Background hourly watch (same CSV path)
powershell -NoProfile -File C:\Users\Matt\git\masonjar\scripts\start_pool_leak_watch.ps1

# One-shot fleet + process churn detail
powershell -NoProfile -File C:\Users\Matt\git\masonjar\scripts\proc_churn_sample.ps1

# Pool snapshot marker + correlation (optional)
powershell -NoProfile -File C:\Users\Matt\git\masonjar\scripts\record_proc_retest_t0.ps1
powershell -NoProfile -File C:\Users\Matt\git\masonjar\scripts\correlate_proc_retest.ps1

# Mason Jar fleet (release vs dev)
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'electron|masonjar' } |
  Select-Object ProcessId, Name, CommandLine
```

Elevated (diagnostics only — **never** modify third-party filters):

```powershell
Get-VM   # expect none
fltmc filters
```

---

## 8. Files touched this session

| Path | Role |
|------|------|
| `scripts/pool_leak_watch.ps1` | **Keep** — pool tag monitor / CSV (includes fleet columns) |
| `scripts/start_pool_leak_watch.ps1` | Start hourly background watch → `~/.masonjar/pool_leak_watch.csv` |
| `scripts/proc_churn_sample.ps1` | One-shot fleet + process delta sample → `~/.masonjar/proc_churn_watch.csv` |
| `scripts/record_proc_retest_t0.ps1` | Optional CSV snapshot marker → `proc_retest_t0.json` |
| `scripts/correlate_proc_retest.ps1` | Summarize pool + jobs since t0; 7-day gate pass/fail |
| `scripts/verify_release_worker.ps1` | Post-install check: batch jobs use `via: worker` |
| `scripts/start_7d_uptime_gate.ps1` | Record t0 + start hourly watch for 7-day gate |
| `scripts/m465_align_repro_watch.py` | Dev only; was running and using ~2 GB private; **do not run on lab server** |
| `scripts/m465-repro-start.ps1`, `scripts/m465_restore_baseline_ap.py` | Unrelated M465 align repro tooling (pre-existing untracked) |
| Temp diag scripts under repo root (`pool-leak-diag*.ps1`, etc.) | **Deleted** during session |

### Implementation status (2026-07-04, post-reboot)

| Item | Status |
|------|--------|
| `scripts/pool_leak_watch.ps1` hourly CSV | Running → `%USERPROFILE%\.masonjar\pool_leak_watch.csv` |
| `src/python_job.ts` supervisor | **Done** — active job map, NDJSON log `~/.masonjar/python_jobs.ndjson`, `killAllPythonJobs` on `before-quit` |
| All `main.ts` / `batch_queue.ts` spawns | **Done** — via `startPyJob` / `startPyJobShell` / `runPythonJob` |
| Renderer `child_process` removed | **Done** — `runIndexMetadata` IPC from `file_index.js` / `preprocess_wizard.js` |
| `py/masonjar_worker.py` | **Done** — in-process `runpy`; allowlisted scripts default **on** (`MASONJAR_PYTHON_WORKER=0` to disable) |
| Job log `build` / `gui` fields | **Done** — distinguishes dev vs release and GUI shell jobs in `python_jobs.ndjson` |
| GUI tools (`map.py`, `adjust.py`) | One-shot supervised shell (`forceShell`); `killChannel` + `onKill` via supervisor |

**Allowlist (worker):** `index_metadata.py`, `max.py`, `sharpen.py`, `top_hat.py`, `region.py`, `count.py`, `collate.py`, `find_neurons.py`, `export_roi_dual_tif.py`, `apply_parcellation.py`, `dapi_cleanup.py`, `tissue_cleanup.py`, `czi_probe.py`, `czi_extract.py`, `apply_geometry.py`, `geometry_fingerprint_probe.py`, `annotation_label_audit.py`.

**Note:** `startPyJobShell` bridges legacy `pyshell.on("message")` to the supervisor; allowlisted scripts run in the worker. Only `map.py` / `adjust.py` force one-shot shell (Qt/Napari).

Correlate `python_jobs.ndjson` (`via: worker|shell`, `build`) with pool CSV over days 1–4.

### Phase C gate measurement (2026-07-04 → 2026-07-05, ~37.7 h uptime)

**Fleet during window:** **1× release** (`masonjar.exe` from packaged 6.0.11 under `Downloads\masonjar-win32-x64`) + **3× dev** (worker build from `git\masonjar`). `python_jobs.ndjson` logs **dev instances only** (shared `~/.masonjar/`); release `PythonShell` spawns are **not** in that file.

| Signal | Baseline (0.3 h) | At ~37.7 h | Pre-reboot bad boot (~106 h) |
|--------|------------------|------------|------------------------------|
| `Proc_MB` | 5.9 | **364.5** | ~1050 |
| `Proc_out` | ~1,670 | **~103k** | ~300k |
| `Proc_frees` | 1 | **1** | 29 |
| `Proc_free%` | 0.06% | **0.001%** | ~0.01% |
| Hourly Δ `Proc_out` | — | **~2,714/h** (flat) | ~2,800/h |
| Projected `Proc_MB` @ 106 h | — | **~1,035 MB** | ~1050 |

**Dev job log:** 90 jobs completed, all `via: worker`, 0 `via: shell` (mostly `index_metadata.py`, some `czi_extract.py` / `apply_geometry.py`).

**Verdict:** **Phase C gate FAIL (preliminary)** under normal mixed fleet (see snapshots below).

---

### Measurement premise: always mixed fleet

| Fact | Implication |
|------|-------------|
| Multiple RDP users (e.g. Matt, John) | Each may run a **different Mason Jar build** from their own profile |
| Prior releases remain in use | **Cannot** require everyone on dev or worker for tests |
| `python_jobs.ndjson` under `~/.masonjar/` | Logs jobs from instances using **that home dir** only—not all users |
| `pool_leak_watch.csv` | **System-wide** kernel `Proc`—the primary metric |
| Fleet columns (`MasonJar_dev`, `MasonJar_release`, …) | Snapshot **mixed** load; track trends as worker release rolls out user-by-user |

**Do not** plan “all-dev retest,” “pause release,” or “unify fleet” as test prerequisites. Ship worker in release; measure **whole-machine** uptime improvement over bad-boot baseline as adoption grows.

### Snapshot marker (2026-07-05 ~23:43 UTC) — Matt session dev-only moment

Matt **removed release from his profile** and ran **3× dev worker** briefly. This was a **labeled CSV row** (`RetestSegment=all_dev_t0`), not a sustainable test arm—**John and other users on prior release is expected forever.**

| t0 metric | Value |
|-----------|------:|
| TimeUtc | 2026-07-05T23:43:08Z |
| UptimeHours | 40.02 |
| Proc_MB | **396.7** |
| Proc_out | **112,060** |
| Proc_frees | 1 |
| MasonJar_dev / release (Matt session snapshot) | **3 / 0** |
| Python_worker / shell | **3 / 0** |
| Pre-mixed-fleet ref Δ/h | ~2,714 |

**Artifacts:** `~/.masonjar/proc_retest_t0.json`, CSV row `RetestSegment=all_dev_t0`, scripts [`record_proc_retest_t0.ps1`](../scripts/record_proc_retest_t0.ps1), [`correlate_proc_retest.ps1`](../scripts/correlate_proc_retest.ps1).

**Later same day:** John logged on (session 4) with release/orphan `masonjar.exe` activity—**normal mixed fleet**, not a test failure.

### Phase C gate measurement (2026-07-04 → 2026-07-05, ~37.7 h uptime) — mixed fleet snapshot

**Fleet during window:** **Mixed** (release + dev on same host)—the **normal** lab condition.

| Signal | Baseline (0.3 h) | At ~37.7 h | Pre-reboot bad boot (~106 h) |
|--------|------------------|------------|------------------------------|
| `Proc_MB` | 5.9 | **364.5** | ~1050 |
| `Proc_out` | ~1,670 | **~103k** | ~300k |
| `Proc_frees` | 1 | **1** | 29 |
| Hourly Δ `Proc_out` | — | **~2,714/h** | ~2,800/h |

---

## 9. Success criteria (mixed fleet, after reboot + fixes roll out)

Under normal **24/7 multi-user** lab use (some sessions on prior release, some on worker release):

1. **System-wide** `Proc_free%` is **not** stuck near **0.01%**, **or** daily **system** `ΔProc_out` is **materially lower** than ~2.8k objects/hour (bad boot)—even while old releases remain on the box.
2. **Machine** remains interactive **well beyond one week** without a 600-mile reboot trip (primary operational win).
3. Worker release **reduces churn per session** that adopts it; full fleet uniformity is **not** required for success.
4. Acute jobs on `Z:` may still be slow (NAS); they should not add permanent `Proc` debt beyond the chronic leak baseline.

---

## 10. Message to the next agent

The user is not asking for a clever reboot workaround—the stuck `Proc` pool **requires** a reboot to clear, and that reboot is **operationally brutal**. Your job is to **make the next uptime last** by shipping and hardening supervisor/worker in **release**, measuring **system-wide** `Proc` with `pool_leak_watch.ps1` under **permanent mixed fleet**, and fixing **only Mason Jar** if the 7-day gate fails. **Never** install or recommend Sentinel/HASP/FlexNet. **Never** block the lab or require all users to upgrade for measurement to count.
