# Commit and release messages (human-facing)

Mason Jar has two audiences. **Do not mix them.**

| Audience | Where to write | Never use for |
|----------|----------------|---------------|
| Lab users (PIs, students, you) | [`RELEASE_NOTES.md`](RELEASE_NOTES.md), git commit messages | Agent session notes |
| Coding agents | [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md) | GitHub “What’s new”, commit subjects |

[`scripts/publish-release.js`](../scripts/publish-release.js) reads **only** `RELEASE_NOTES.md`. It does **not** read `AGENT_HANDOFF.md`.

---

## Git commits

**Subject** (≤72 characters): what changed for someone using the app. Imperative mood. **No** `v2.4.x:` prefix—the git tag carries the version.

**Body** (optional, 2–4 sentences): what was broken or missing, what you did, who benefits. Plain language.

### Bad

```
v2.4.9: fix CZI multi-Z signal preview numpy truthiness
```

```
Fix cumulative orient geometry preview with ordered ops.

Per-slice geometry.ops records click order; DOMMatrix preview matches apply_geometry.py on disk.
```

### Good

```
Orient preview keeps rotate and flip steps together

Rotating a slice and then flipping it no longer looked like the rotation was undone. The CZI import wizard and Orient slices from the menu now show the same combined preview you get after Apply geometry.
```

Before committing a release, run:

```bash
node scripts/release-message.js
```

Copy the suggested subject and body, or write your own following the same tone.

---

## GitHub release notes (`docs/RELEASE_NOTES.md`)

Add a section **before** `node scripts/publish-release.js`:

```markdown
## v2.4.11

**What's new**

Two or three sentences a lab member can read without opening the repo. Describe what they can do differently in Mason Jar (tool names from the UI are fine).

**Changes**

- Short bullet list of user-visible changes (optional but helpful).
- Still no file paths, test names, or “for agents” instructions.

**Commit subject** (optional)

One-line git commit subject; `release-message.js` uses this if present.

**Commit body** (optional)

Paragraph for the git commit body.
```

Newest version at the **top** of the file.

### Bad (What’s new)

> Cumulative orient geometry: per-slice `geometry.ops` with DOMMatrix preview WYSIWYG in `js/orient_geometry.js`…

### Good (What’s new)

> When you rotate a slice in Orient, then flip it, the preview keeps both steps instead of looking like the rotation was undone. The same behavior applies in the CZI import wizard and **Orient slices** from the start menu.

---

## Release checklist (agents)

1. Bump `version` in `package.json`.
2. Add **`docs/RELEASE_NOTES.md`** section for that version (human copy).
3. Update **`docs/AGENT_HANDOFF.md`** (technical; agents only).
4. `node scripts/release-message.js` → commit with human subject/body.
5. `node scripts/build-release.js`
6. `git tag vX.Y.Z` → `node scripts/publish-release.js`

See also [`AGENTS.md`](../AGENTS.md) — Release builds.
