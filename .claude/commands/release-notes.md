---
description: Generate release notes for devForge from git commits in a tag range
---

You are generating user-facing release notes for **devForge** — an Electron desktop developer toolkit with utilities for PageSpeed audits, Azure App Service monitoring, CSS audits, image conversion, cheatsheets, and translation/localization.

## Arguments

User-provided arguments (may be empty):

```
$ARGUMENTS
```

Possible forms:
- `v1.2.0..v1.3.0` — explicit range
- `v1.3.0` — single tag (compare to its predecessor)
- *(empty)* — commits since the latest tag up to `HEAD`

## Workflow

Repo root is `c:/GitProjects/devforge/`. Run all git commands from there.

### 1. Resolve the range

- If `$ARGUMENTS` contains `..`, split on `..` → `prevTag`, `currTag`.
- Else if a single tag is given, set `currTag=<that>`, then `prevTag=$(git describe --tags --abbrev=0 ${currTag}^ 2>/dev/null)`.
- Else `prevTag=$(git describe --tags --abbrev=0)`, `currTag=HEAD`.
- Echo what you resolved so the user can verify.

### 2. Collect commits

Run:
```bash
git log <prevTag>..<currTag> --pretty=format:"%h|||%s|||%an|||%b<<<END>>>" --no-merges
```

Parse into entries: `{ hash, subject, author, body }`.

### 3. Filter out noise

Drop any commit where:
- Author is `github-actions[bot]`
- Subject starts with `chore: release`
- Subject is pure `chore:`, `test:`, `style:`, `build:`, or `ci:` (these are internal and add no user value) — UNLESS the user explicitly typed `--all` in arguments.

### 4. Parse and categorize

For each remaining commit, parse `type(scope)!: description`:

- **Breaking** if `!:` appears in subject OR `BREAKING CHANGE:` appears in body
- **feat** → ✨ What's New
- **fix** → 🐛 Bug Fixes
- **perf** → ⚡ Performance
- **refactor** → ♻️ Refactors (only if user-visible)
- **docs** → 📝 Documentation
- Anything else worth keeping → 🔧 Other Changes

### 5. Enrich descriptions

For each commit, write a **user-facing** bullet:
- "Users can now X" rather than "Implemented X"
- Skip implementation jargon, framework names, internal flag names
- If the subject is vague (e.g., "feat: updates"), inspect the diff with `git show --stat <hash>` and `git show <hash> -- <key-file>` to figure out what the change actually does
- If multiple small commits target the same feature/file, **collapse them into one bullet** — append the additional hashes after the main one

Each bullet format:
- With scope: `- **<scope>:** <user-facing description> ([\`<sha>\`](<commit-url>))`
- Without scope: `- <user-facing description> ([\`<sha>\`](<commit-url>))`

Commit URL pattern: `https://github.com/jasonrosalinda/devforge/commit/<full-sha>` (you may use short sha in the link text).

### 6. Assemble the Markdown

Order of sections (skip empty ones):

```
### ⚠️ Breaking Changes
### ✨ What's New
### 🐛 Bug Fixes
### ⚡ Performance
### ♻️ Refactors
### 📝 Documentation
### 🔧 Other Changes
```

Prepend a one-line **header summary** as a blockquote tallying the changes:

```
> N new features · M bug fixes · K performance improvements
```

Append a **footer**:

```
**Full Changelog**: https://github.com/jasonrosalinda/devforge/compare/<prevTag>...<currTag>
```

### 7. Output

1. Print the full Markdown to chat inside a fenced code block so the user can copy it directly.
2. Save the same content to `c:/GitProjects/devforge/release-notes/<currTag>.md` using the Write tool. If `currTag` is `HEAD`, use the current `package.json` version (`devforge/package.json`) — e.g. `release-notes/v1.3.1.md`. Create the `release-notes/` directory if missing.
3. End your reply with a one-line note: where the file was saved, and a suggestion to paste it into the matching GitHub Release.

## Style rules

- Concise. One line per bullet.
- No emojis inside bullet text (emojis only in section headers).
- No marketing speak. No "exciting", "amazing", "powerful".
- Past tense for fixes ("fixed X"), present tense for new features ("X now does Y").
- Skip personal pronouns ("we", "you") — write in plain declarative tone.

## Example output (reference shape, not literal content)

```markdown
> 3 new features · 2 bug fixes · 1 performance improvement

### ✨ What's New

- **pagespeed:** AI insights report now includes per-URL LCP phase breakdown ([`abc1234`](https://github.com/jasonrosalinda/devforge/commit/abc1234))
- **azure:** App health check shows p99 metrics for CPU and memory ([`def5678`](https://github.com/jasonrosalinda/devforge/commit/def5678))
- Settings modal supports multiple Azure app entries with inline edit ([`ghi9012`](https://github.com/jasonrosalinda/devforge/commit/ghi9012))

### 🐛 Bug Fixes

- PageSpeed cancel button stops in-flight requests immediately ([`jkl3456`](https://github.com/jasonrosalinda/devforge/commit/jkl3456))
- Retry no longer resets the audit duration timer ([`mno7890`](https://github.com/jasonrosalinda/devforge/commit/mno7890))

### ⚡ Performance

- Parallel URL processing for PageSpeed audits (configurable 1–3 concurrent) ([`pqr1234`](https://github.com/jasonrosalinda/devforge/commit/pqr1234))

**Full Changelog**: https://github.com/jasonrosalinda/devforge/compare/v1.2.0...v1.3.0
```
