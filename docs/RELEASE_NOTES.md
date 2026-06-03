# Mason Jar release notes (human-facing)

Copy for GitHub releases and suggested git commits. **Newest version at the top.**

Do not put agent instructions, file paths, test names, or IPC details here—use [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md) for that.

---

## v2.4.10

**What's new**

When you rotate a slice in Orient, then flip it, the preview keeps both steps instead of looking like only a flip or only a rotation. The same behavior applies in the CZI import wizard (Orient step) and in **Orient slices** from the start menu, and what you see in the preview matches what gets written when you click **Apply geometry**.

**Changes**

- Orient and CZI import: rotate and flip actions stack in the order you click them.
- CZI import (2.4.7–2.4.9): more reliable mosaic and counterstain reads; wizard reprobe and multi-Z extract fixes on Windows.

**Commit subject**

Orient preview keeps rotate and flip steps together

**Commit body**

Rotating then flipping a slice no longer reset the preview. Orient slices and the CZI wizard now apply geometry clicks in order so the preview matches the files written on disk.
