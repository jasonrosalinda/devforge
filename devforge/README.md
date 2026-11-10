# devForge

Developer toolkit built with Electron, React, and TypeScript. Bundles Azure App Service / Container Apps monitoring, PageSpeed auditing, unused-asset scanning, release runbook prep and everyday developer utilities into a single cross-platform desktop app.

---

## Pages

Every page opens as its own tab from the sidebar. The sidebar groups them as below. The page list lives in [src/routes/page-routes.tsx](src/routes/page-routes.tsx) and the Toolbox tools in [src/components/toolbox/toolbox-registry.ts](src/components/toolbox/toolbox-registry.ts). **When you add, remove or change a page, update this section in the same PR.**

### Home

**Use it to** see whether any app needs you, the moment devForge opens: a live summary of App Health Check for every configured app over the last 6 hours. Tools open from the sidebar, and its search filters them.

- **One card per app**, laid out as a grid. While it loads, each app shows a placeholder card under its name. Under the name, a card says "Healthy — nothing in the last 6 hours", or what needs attention, worst first: an UptimeRobot monitor reporting down, active downtime, FE or API 5xx above 5% (judged from the same value the card shows), a warning or critical status (with the CPU and memory averages behind it), and the latest anomaly episode.
- **On each card:** status dot, CPU and memory sparklines for the 6 hours, and 5xx-rate sparklines split into **FE 5xx** and **API 5xx** whenever the app has an API, so you can see which side is failing. Each 5xx value is the latest minute: exactly `0%` when there were none, `<0.1%` when there were a few, and a smaller **peak** figure underneath whenever the 6 hours had any 5xx. The API side is read from its App Insights, which works for Container Apps too, or from Azure Monitor's Http5xx for an App Service API without App Insights (with current values; dashed lines are releases, and the red line on 5xx is the 5% alert threshold), how long ago it was last released (hover for the build and who), and UptimeRobot's live Up / Down when monitors are set.
- **Click a card** to open App Health Check on that app for the same 6 hours.
- It loads by itself and refreshes every 5 minutes, but only while Home is the visible tab, so a hidden window or another tab costs no Azure calls. If a check fails, **Retry** runs it again. It judges each app by the same rules as the tray monitor, through the monitor's own lightweight fetch, so it never changes an open App Health Check tab.
- **Needs:** `az login` and apps in **Settings → Azure** (Home links there when none are set). UptimeRobot status needs the key in **Settings → API Keys**.

### Monitoring

#### App Health Check

**Use it to** see how Azure apps behaved over a time window, and to explain an outage or a spike: during an incident, for a daily check, when a tray alert fires, or after a release to compare before and after.

- Pick one or more apps and a From / To range (defaults to today 00:00 → now) at 1m–6h granularity. You can turn on **Auto reload** to keep the end at "now".
- **Remarks** tell the story of the range, one line per finding with an icon for its severity:
  - **Right now:** what is active in the latest bucket. The line is left out when nothing is. A 4xx surge or 5xx errors remark gives its peak rate and the time of that peak (SGT). Under it, a bulleted list gives the top five status code and endpoint pairs from App Insights for that bucket, each with the share that came from bots (judged by user agent, so a bot posing as a browser counts as human), e.g. "FE 4xx surge (peak 5.3% at 14:30)" followed by "404 × 120 on GET /x (100% bot)". Copy for Teams nests the same list under the line. The FE/API prefix appears when the app has an API. The role is named in brackets when the codes span more than one role. If App Insights has no record of those failures, the line says so; IIS-level 404s, for example, are counted by Azure Monitor but never reach the app.
  - **Incidents, in the order they happened:** downtime; 5xx bursts per site (FE / API); critical spikes; warning-level spikes folded into one line; and restarts with their causes, alongside captured crashes. Many bursts on one site become one line with the count, total time, peak, and a **recurring roughly every N min** note when they come at a regular rhythm.
  - **Connections:** an incident that began within an hour of a release says so ("began 6 min after the 16:54 FE swap"), and restarts within 10 minutes of a crash are called out.
  - **One-click actions** on each line: **List requests** opens the 5xx requests behind a burst, and **Verdict** opens the Release Verdict for the release it lines up with.
  - A last line lists the releases in range.  - Remarks are written only after the card's metrics, App Insights details and UptimeRobot logs have all loaded (until then the block reads "Waiting for all data to load…"), so they never flip as late data arrives. **Copy for Teams** pastes the same lines; the AI remarks still use the one-sentence "right now" summary.
- Each app gets a card with a status (healthy / warning / critical). **Blocks** choose what the card shows: Remarks, CPU, Memory, Database, Users, Page Load, Performance, Exceptions, Instances, UptimeRobot, SNAT Ports, Restarts, Crash Monitoring, Anomaly Detection, Incident Timeline, and Frontend / API.
- **Incident Timeline** puts one lane per event source on a shared axis for the range: releases, restarts, crashes, downtime (UptimeRobot, else Azure availability), anomaly episodes (Warning and Critical), and 5xx bursts (buckets above 5% merged into one bar). For an app with an API, the bursts are split into **FE 5xx** and **API 5xx** lanes, each drawn from that site's own App Insights request timeline. Hover any mark for its details, so "release → restart → downtime" reads at a glance. **Click a 5xx burst** to list the 5xx requests behind it from App Insights. The list opens on the burst's own site, and you can switch between Frontend and API: time (SGT), result code, request, URL, duration, instance and operation ID (click to copy), newest first, 25 per page. The 1,000 newest records are listed, alongside the true total. A record marked ×N stands for N sampled requests. Like Remarks, it waits until all the card's data has loaded.
- **Release Verdict** ("did this release hurt?"): click a release mark in the timeline, or a section's **Last release** label. The dialog compares the hours before the release with the hours after it (1h / 2h / 6h; the after side stops at now and needs at least 15 min). It covers CPU avg / p99, memory, requests per minute (context only), response p95, 5xx and 4xx rates, exceptions per 1k requests, dependency failures, and restarts and crashes per hour. A row counts as worse or better only when it moves at least 20% and past a per-metric floor. Exception types with 5+ hits in the after window's top 10 that weren't in the before window's top 10 are flagged as new. The verdict is **Regressed**, **Improved** or **No change**. **Copy for Teams** pastes the table, and **Open range in Health Check** loads that window for the app. Its fetches never repaint the cards behind it.
- **Release markers:** every time chart on the card draws a dashed line where a release reached production (FE darker, API fainter; the CPU / Memory chart labels each one with its SGT time), so a change in CPU, restarts or errors reads as before vs after the release. The **Frontend** and **API** section headers each show that site's **Last release**, even when it falls outside the range (30-day look-back); hover it for the build, commit and who released. The card header shows it instead for a site whose section is not on screen: the card is collapsed or the block is hidden. Releases come from the Activity Log (slot swaps, including manual ones) and the Kudu deployment history (pipeline deploys and swaps); Container Apps use their revisions.
- **Anomaly Detection** flags correlated spikes across CPU, memory, DB CPU and DB memory (plus FE/API error rates when App Insights is available).
- **Copy for Teams** puts the status header, chart image, metrics table and remarks (one plain, coloured bullet per remark) on the clipboard in one paste.
- **Copy one side for Teams.** The share icon in the Frontend or API header copies just that side: its request chart, the Request figures (total, successful, 4xx, 5xx), the Response figures (P95 peak, average, slowest), and its Exceptions, Restarts (with their causes) and Crashes counts. A figure that has not loaded yet shows as "—".
- **Bot share per endpoint.** The Performance table has a **bot** column next to requests: the share of that endpoint's requests made by bots, crawlers and scripts, judged by user agent (a bot posing as a browser counts as human). "<1%" means a few; "—" means the result was cached before the column existed, so refresh.
- **RCA.** The card has no RCA section; write one from **App Investigation**, whose RCA and Tracker tabs are filled by the investigation.
- **Needs:** `az login`, and apps configured in **Settings → Azure**. Optional: an App Insights ID, a database, and the API app per entry. UptimeRobot needs a key in **Settings → API Keys**. Release markers need Reader on the app's resource group (the header shows "n/a" without it). RCA needs the [Claude CLI](https://docs.claude.com/en/docs/claude-code) on PATH. Desktop app only.

#### Ask Telemetry

**Use it to** answer a question about an app's Application Insights that App Health Check has no block for, without writing KQL or opening the Azure Portal. For example: "which endpoints got slower today?", "top exception types on the API this week" or "failed dependency calls by target".

- The header shows your Azure CLI sign-in state (**Authenticated** / **Not authenticated**), same as App Health Check. Click it to re-check, or copy `az login` when signed out.
- Pick an app, **Frontend** or **API**, and a range (1h / 24h / 7d / custom), then type the question (Ctrl+Enter). Starter questions and your recent ones sit under the box.
- Claude writes one KQL query from the app's real table schema. devForge runs it read-only and shows the query, a one-line explanation, a chart (a line over time, split by category up to 8 lines, or bars for a breakdown) and the full table.
- If App Insights rejects the query, Claude gets the error and fixes it once by itself. The query shows a **repaired** badge when that happens.
- The query stays editable. **Run** (Ctrl+Enter) runs your edit directly, with no Claude call. Results are capped at 5,000 rows.
- **Save** keeps a query in the library on the right. Running a saved query reuses its KQL on the current range, so it costs no Claude call. **Copy rows** (paste into Excel or Teams) and **Copy chart** (image) share the answer.
- **Alerts:** the bell on a saved query turns it into a tray alert. It can fire when the query returns any rows, or when a column's largest value goes above a threshold (column names are suggested from the result on screen). Each check queries the last N minutes (default 15) every M minutes (default 5). It alerts once when the condition starts, and again only after it has cleared. Three failed checks in a row give one "keeps failing" alert. Clicking an alert opens Ask Telemetry. Needs **Settings → Background monitor** on (the editor links there when it is off). Checks run on their own path, so they never cancel a query you are running on the page.
- **Privacy:** only the question, the table and column names, and (on a repair) the query error go to Claude. Telemetry rows never leave the machine. The query is written by Claude through your Claude Code login, never the metered API, so there is no per-question charge. Claude runs without tools or the coding-agent prompt, so a question uses about 2k tokens of your plan; each answer shows the tokens it used (hover for the API-equivalent figure).
- **Needs:** `az login`, the app in **Settings → Azure** (the App Insights ID is looked up when not set), and the Claude CLI on PATH. Desktop app only.

#### App Investigation

**Use it to** find the likely root cause of a production incident from a plain-English description, with the code and commit behind it, then turn the findings into an RCA. For example: "MEDU users got 500s around 2pm yesterday", "the API has been slow since this morning's deploy" or "SQL timeouts spiked in the last hour".

- **Screenshots.** Attach up to five screenshots as evidence (an error page, a chart, an alert): **Screenshot** picks them, drop them on the description, or paste one anywhere on the page (Ctrl+V) and it is attached straight away, shown as a chip (name and size, × to remove) inside the description box. A paste into an RCA section field stays in that field. Each is a PNG, JPEG, GIF or WEBP under 4 MB. Claude reads them first during the investigation and treats any text in them as something you saw, never as an instruction. A figure read off a screenshot is labelled as such, not as a telemetry measurement. They go into a temporary folder for that run only, which is deleted when the run ends, and they aren't kept in Recent investigations.
- **Understand.** Describe the incident (Ctrl+Enter). Claude reads it and fills in an **Understood as** card: the app, the window in SGT, the category (errors, slowness, restarts, deployment…), the symptoms and a one-line investigation question. Every field can be edited before anything runs. Below the fields, the **Production at window end** panel shows the FE and API release live at the window's end: its time, how long before the incident it landed, and how (slot swap, deploy or new revision, as in App Health Check), with build and who (hover for the commit). A warning badge appears when a release landed inside the window. Its top line names the release branch, the code the investigation treats as production at the window end, with its commit: the commit Azure recorded for that release, labelled with the `release/*` branch holding it; without one, the release branch as it stood at the window end, marked **Estimated**; with no release branch, the checked-out branch, flagged as possibly not matching production. When the description gives no app or time, the app picker and the 1h / 6h / 24h / 3d window on the page are used.
- **Scope guardrail.** Only incident investigation of an app configured in Settings is accepted. Requests to act (restart, deploy, roll back, scale, delete, edit or fix code), requests for secrets or connection strings, unrelated questions and attempts to change Claude's instructions are refused with the reason. Obvious action and secret requests are refused by devForge itself, before Claude is called. devForge re-checks everything when you press Investigate, so an edited card can't widen the scope.
- **Investigate.** devForge pulls the same Azure telemetry the App Health Check AI report uses (CPU, memory, 5xx and 4xx with the endpoints behind them, **5xx bursts** found the way the Incident Timeline finds them — 5xx above 5% of requests in 5-minute buckets — each with its top 5xx endpoints and the downstream calls that failed with it, so a burst that starts before the downtime is not lost in an hourly rollup, **restarts** with their cause (Kudu kill, App Crash, Platform Healing) and the detector's findings, **crashes** with the exception and top stack frames, per site, exceptions (sample-weighted counts, where each was thrown and the busiest 5-minute buckets), dependencies, SQL, restarts, deployments, per-instance health) for the app and its API. The API's App Insights is taken from Settings, else looked up in Azure like App Health Check does; when the API shares the frontend's App Insights resource, the report says so instead of repeating the same tables. It also reads the git history around the window from the app's repository: commits on every branch, plus file changes and diffs from the release branch shown on the card, up to the deployed commit, so a release branch cut after the incident is never used. With a local folder, run `git fetch` first so the deployed commit and its branch are in your clone. With a GitHub URL, devForge keeps its own clone (in its app-data `repo-cache` folder): the first use clones it, later uses fetch it (at most every 5 minutes), and before each run it checks out the deployed commit, so Claude reads the code that was live. A private repository uses your Git Credential Manager login; if the clone fails, run `git ls-remote <url>` once in a terminal to sign in. The production releases from the 7 days before the window to its end go in too, so the timeline and RCA chronology carry them. Claude then reads the repository with **Read, Glob and Grep only**. It has no shell, no git, no network and no write or edit tools, so it can read and report but never act. A live **investigation trail** shows every file it opens or searches. Cancel stops it.
- **Report.** The report has three tabs, all filled by the same run. **Findings** is the investigation itself: Summary, Timeline, Azure Evidence, Code Suspects, Root Cause (ranked hypotheses with confidence), Recommended Fix (for a code change, the **Current** lines copied from the file and the **Fix** with the change applied, as suggestions only), and Gaps & Next Checks. `file:line` citations open in VS Code. Every SHA and path must be real, and where the code can't explain a signal the report says **Insufficient evidence in this repository.** You can save the findings as `.md`, PDF or Word (`investigation-…` in `~/.claude/agents/incident-reports/`) or copy them for Teams. Finished reports are kept under **Recent investigations** (last 20, on this machine).
- **RCA and Tracker tabs.** The RCA as an editable form, split into two tabs, with PDF, Word and Copy for Teams exports. Both can be filled in before a run. The form is titled after the app by default (e.g. "MEDU Downtime"), with the Incident Period taken from UptimeRobot downtime in the window. After the findings, the same run writes an RCA of the incident (an incident number, 1. Background to 7. Current Status, and the Tracker), bringing in the code: the chronology carries the relevant commits, the root cause names the file and commit behind it, and the preventive actions name the files to change. It fills every blank field of both tabs, so each one can be edited; anything already typed is kept, and edits survive switching tabs. Exports include your edits but not the Tracker, which stays on its own tab (with its own copy buttons). The PDF, Word and Markdown files are named after the incident number in the form plus the app's **Incident file suffix** from Settings, e.g. `INC-202611-004 (MIMS-CPD).pdf`; with no incident number the name falls back to the window, and the investigation report keeps its own `investigation-…` name. There is no separate Generate step on this page. Each Tracker field has its own copy button, and **Copy all** copies every filled field as a "Label: value" line.
- **Safety and cost.** If the repository changes during a run, a warning says so. Report text is rendered with raw HTML removed and only web links kept. Runs use your Claude Code login, never the metered API. Each report shows the tokens it used (hover for the API-equivalent figure). Understanding a description is a lean call of about 3–4k tokens. An investigation is a full agent run, capped at an API-equivalent of $2.
- **Needs:** `az login`, the app in **Settings → Azure** with its **App repository** (and **API repository** only if the API lives in a separate repository; otherwise the app's is used for both, and the card hides the **Code to read** choice) set to a local git clone or a `https://github.com/<owner>/<repo>` URL, and the Claude CLI on PATH. Desktop app only.

#### Service KPI

**Use it to** fill in the monthly Service KPI report without opening the Azure portal, Cost Analysis and UptimeRobot one by one. Pick last month, press Fetch, and copy each figure (or the whole table) into the Excel file. It covers every app in **Settings → Azure**, not only MEDU.

- **Month.** Defaults to the previous month in SGT. The window is shown in the report's own wording (`01 Mar 2024 12:00:00 AM to 31 Mar 2024 11:59:59 PM (UTC+08)`), with a copy button.
- **One row per site.** Each configured app gets a row, plus a row for its API when one is set. A checkbox leaves a row out of the fetch and of Copy all. Columns: **CPU % (avg)**, **Memory % (avg)**, **DB CPU % (avg)** (when the app has a database), **5xx errors** (when the site has App Insights), **Uptime %** (when the platform has UptimeRobot monitors) and **RG cost (USD)**. A column that doesn't apply shows "-", and hovering it says what to add in Settings.
- **How figures are read.**
  - CPU, memory and DB are the mean of the daily averages over the SGT month. This can differ slightly from the portal's whole-range average when a day has missing samples.
  - App Service CPU and memory are for the App Service plan, as the portal dashboards chart them, so sites on one plan show the same numbers. The plan name is under the app name.
  - Container Apps use their own `CpuPercentage` / `MemoryPercentage`.
  - 5xx counts every request with a 5xx code, plus failed requests with no code (the same rule as App Health Check), weighted for sampling. It uses each site's own App Insights resource.
  - Uptime is UptimeRobot's exact uptime % for the month (`custom_uptime_ranges`), averaged across a platform's monitors, so long months aren't cut short by the 50-log limit.
- **Cloud cost.** The Cost Management figures for the UTC calendar month, with copy buttons throughout:
  - **By resource group.** Tick groups to get **Selected groups by service** and their combined total. This is how a platform's report lines read; for example, the "MEDU (last month)" Cost Analysis view is `prdmedu-rg` + `uatmedu-rg` together. The configured apps' groups start ticked.
  - **Subscription by service** and the subscription total.
  - **The RG cost column** in the table is the app's whole resource group. When several rows share a group the hover says so, so don't add those cells up.
  - **Throttling.** Cost Management allows only a few queries a minute. A throttled request is retried once, then the card asks you to wait a minute.
- **Copying.** Every value has its own copy button, every row has Copy row, and **Copy all** copies the table as tab-separated text that pastes straight into Excel cells. Values are rounded as the report asks: 2 dp, uptime 1 dp, 5xx as a whole number.
- **Failures stay local.** A missing permission or resource marks only its own cell (hover for the reason), and the rest of the page still fills in.
- **Not covered:** average page load (Google Analytics) stays a manual step.
- **Needs:** `az login`, the apps in **Settings → Azure**, the **Cost Management Reader** role on the subscription for cost, and the UptimeRobot API key in Settings for uptime. Desktop app only.

Implementation: [electron/ipc/azure-kpi.cjs](electron/ipc/azure-kpi.cjs), [src/pages/serviceKpiPage.tsx](src/pages/serviceKpiPage.tsx), [src/lib/service-kpi.ts](src/lib/service-kpi.ts)

#### Config Diff

**Use it to** check, before a slot swap or a UAT → PRD release, that two App Service sites have the same app settings and connection strings, without opening both Configuration blades side by side.

- Pick a **Left** and a **Right** site (each configured web app, and its API when that is an App Service) and a slot for each (**production** or any deployment slot, listed from Azure). **Compare**, or swap the sides with the arrow button.
- Every app setting and connection string name is listed with its status: **Only in left**, **Only in right**, **Differs** or **Same**, differences first. Filter chips show the counts. Badges mark connection strings (with their type) and **slot settings** (sticky, stays with its slot on a swap).
- **Values never leave the main process.** devForge reads them, compares them on this machine and sends only the names and statuses to the page. They aren't shown, logged or sent to Claude, and error messages never include Azure's response. **Copy** puts the names and statuses on the clipboard as tab-separated text.
- Container Apps aren't covered: they have no App Service settings.
- **Needs:** `az login` and the apps in **Settings → Azure**. Reading settings needs the `config/list` action (**Website Contributor** or higher) on each site's resource group, because Reader is not enough. Without it, that side shows a "No permission" line naming the resource group. Desktop app only.

Implementation: [electron/ipc/azure-config.cjs](electron/ipc/azure-config.cjs), [src/pages/configDiffPage.tsx](src/pages/configDiffPage.tsx), [src/lib/config-diff.ts](src/lib/config-diff.ts)

#### Cert & Domain Expiry

**Use it to** see how many days each app's TLS certificate has left, before a lapsed certificate takes a site down.

- Pick apps (all by default) and **Check certificates**. The hosts are each app's **platform URLs** from Settings, plus the host names Azure has bound to the web app and the API (App Service host names, or a Container App's ingress FQDN and custom domains). Kudu (`*.scm.*`) hosts are skipped. Without Reader access, or when signed out, only the platform URLs are checked.
- One row per host, soonest expiry first: host, app (and whether it came from a platform URL, the web app or the API), expiry date in SGT, **days left** (red under 14, amber under 30, or "Expired N d ago"), issuer and **Trusted**.
- devForge only reads the certificate from the TLS handshake on port 443 and sends nothing. What each row shows depends on what the handshake reports:
  - **An expired certificate** keeps its real dates and shows "Expired N d ago".
  - **A certificate that doesn't name the host** shows its days left, plus **Doesn't cover this host** under Trusted. Hover it to see the names the certificate does cover.
  - **A certificate whose chain this machine can't trust** says **Can't verify from this network** instead of a days-left figure. A self-signed certificate does this, and so does a TLS-inspecting corporate proxy, whose date would be the proxy's.
  - **An unreachable host** shows its error.
- With the background monitor on, the same check runs once a day and alerts when a certificate drops under 14 days or expires (see Background monitor).
- **Needs:** apps in **Settings → Azure** (platform URLs and/or `az login` with Reader on the apps). Desktop app only.

Implementation: [electron/ipc/cert-expiry.cjs](electron/ipc/cert-expiry.cjs), [src/pages/certExpiryPage.tsx](src/pages/certExpiryPage.tsx), [src/monitor/certAlerts.ts](src/monitor/certAlerts.ts)

### Web quality

#### PageSpeed

**Use it to** measure a site's Lighthouse performance, or to prove a release made it faster or slower.

- Add https URLs; each is audited on **Desktop** and **Mobile** through the PageSpeed Insights API: SI, LCP, CLS, TBT and FCP, plus opportunities and diagnostics.
- There are three modes. **Single** takes one snapshot. **Comparison** shows before → after with % change. **Accuracy** does 1–10 runs per URL, averaged or median.
- **Copy for Teams** (Excel-style table), **Copy as Image** and **Claude Analysis** (a short findings / assessment summary).
- A **Fix brief** writes a Markdown task file into a repo folder for an AI coding agent. **History** keeps up to 25 saved runs.
- **Needs:** a Google PageSpeed API key in **Settings → API Keys**. Claude Analysis needs the Claude CLI. Full guide: [docs/pagespeed-insights.md](docs/pagespeed-insights.md).

#### Unused Assets

**Use it to** clean up a front-end codebase by finding CSS classes / ids and JS functions nothing references.

- Pick a project folder and scan. The results come as two searchable lists, unused CSS and unused JS, with a code view per item.
- An AI **review** checks each item and gives a verdict. If you stop it, the items already checked keep their verdict.
- Download a Markdown report of a scan. Past scans are kept in history.
- **Needs:** the desktop app. The AI review also needs the Claude CLI.

### Release

#### Release Pilot

**Use it to** prepare and run a deployment from its Confluence runbook without switching between pages.

- Paste the **Deployment Runbook** URL, and optionally the **Release Plan** URL (the release goals are taken from it). It loads the activity table and every screenshot, including ones inside expand drawers.
- Copy a Teams-ready summary, either as text only (always fits) or with full-resolution screenshots. You can also copy any single screenshot.
- **Export** every section as one full-quality HTML file.
- **Needs:** a Confluence base URL, account email and API token in **Settings → Atlassian**.

#### Release Runbook

**Use it to** write or update a Confluence deployment runbook without hand-editing its tables: start a new one from a template, or move a whole deployment to a new start time.

- Start one of three ways. **Edit a runbook** opens a page URL (past URLs are remembered). **New from template** loads a template or an earlier runbook, resets the statuses to TODO, empties the logbooks and drops the "[Template] " prefix. **New blank runbook** gives Pre-Prod, Prod, Post-Prod and Rollback sections with the standard columns.
- Edit rows: insert, duplicate, move, delete, and merge with or split from the row above. Pick PICs through Confluence user search. Edit a cell as rich text, with pasted screenshots and task lists. Planned start and end are recalculated from Time and Duration, and an unreadable duration is flagged.
- **Reschedule:** set the deployment start date and time (SGT) and the activity it starts with. Every date, time, planned time, logbook check time and the date in the title move by the same offset.
- **Review & save** shows a diff first; nothing is written until you confirm. **Create page…** and **Save as template…** create a new page and copy the screenshots across.
- **Safe by design:** only tables with both a Time and an Activity column are treated as runbook tables, and a cell nobody touched is saved back unchanged. A table with merged cells is read-only ("Edit it in Confluence"). If someone else saved the page in the meantime, devForge shows who and when, never overwrites, and lists your edits that would be lost on reload.
- **Needs:** a valid Confluence URL, email and API token in **Settings → Atlassian**, and edit permission on the page or space (a 403 means the account or token is not allowed).

### Utilities

#### Translation

**Use it to** look up, add or edit localization keys across EN, ID and VN.

- A searchable, sortable table of keys and their values. You can add, edit and delete entries.
- Import and export as `.sql`, and copy the table as an image.

#### Toolbox

Offline utilities, each on its own page. Nothing you paste leaves the machine. The only network call is a URL you ask JSON / YAML / XML to load.

| Tool | Use it to |
|------|-----------|
| **DateTime Converter** | Convert a time between local, UTC, other time zones, ISO 8601 and Unix timestamps — e.g. to read a log timestamp in SGT. **Bulk text → SGT** takes pasted logs, JSON or a table and restates every timestamp in SGT (or another zone you pick), leaving the rest of the text as it is. It reads ISO 8601 with a zone (`Z`, `+00:00`, `-05:00`), `… UTC` / `… GMT` and HTTP dates. **No zone = UTC** also converts date-times with no zone, as App Insights and SQL exports often are. Milliseconds are kept, and Unix numbers are left alone. |
| **JWT Decoder** | Decode a token and read its claims, with expiry and issue times shown in local time and UTC. |
| **Regex Tester** | Try a pattern against sample text, with warnings where .NET's regex engine behaves differently. |
| **Cron Explainer & Creator** | Explain an existing cron / NCRONTAB expression, or build one, and preview its next runs. |
| **JSON / YAML / XML** | Format, validate and convert config between the three formats. Paste the input, **Open file…** (browse to any folder), drop a file onto the input, or **Load URL** (http/https; the desktop app fetches it from the main process, so sites without CORS work too, with no cookies or credentials sent). Files and URLs are capped at 5 MB, and the input format is picked from the extension, Content-Type or content. **Tree view** on the output panel shows the input read-only as a collapsible tree: keys, values coloured by type, item and key counts, **Expand all** / **Collapse all**, and each row's path on hover (e.g. `spec.containers[0].image`). A node shows its first 200 children. **Dates → SGT** restates every timestamp in SGT: rewritten in the converted output (with a count), and shown beside the value in the tree, where the input is left unchanged. **No zone = UTC** includes date-times that carry no zone. |
| **Encoders** | Base64, URL and HTML encode / decode, hashes (SHA) and UUIDs. |
| **Text Diff** | Compare two blocks of text line by line. |
| **Image Converter** | Convert images between PNG, JPEG, WebP, ICO and SVG (traced or embedded), e.g. to make a favicon. |
| **App Settings Converter** | Turn `appsettings.json` (comments and trailing commas allowed) into Azure App Service settings: Advanced-edit JSON (optionally all sticky slot settings) or `NAME=value` lines, with nested keys as `Section__Key` and arrays as `Origins__0`. Warns when two names differ only by case. Also converts back from Advanced-edit JSON or `NAME=value` lines to nested JSON (values come back as strings). |
| **Connection String Parser** | Split a SQL Server, Storage, Service Bus / Event Hubs, Cosmos DB, Redis or App Insights connection string into fields, with the kind detected. Passwords and keys are masked until you switch on **Show secrets**; each field has a copy button. |
| **Color & Contrast** | Convert a colour between HEX, RGB and HSL, and check text / background contrast against WCAG AA and AAA (normal and large text, UI components), with a live preview. |

---

## Background monitor (system tray)

**Use it to** get a desktop alert when a watched Azure app degrades, without keeping the App Health Check page open. Turn it on in **Settings → Background monitor**.

- It checks the watched apps every minute over the last 6h at 1m buckets. It fetches only what the alerts need, in a few batched Azure calls.
- It alerts when:
  - the status gets worse;
  - 2 or more of CPU, memory, DB CPU and DB memory spike together;
  - 5xx errors (status 500+, or a request that failed with no status code; 4xx never count) go above 5% of requests;
  - UptimeRobot reports downtime;
  - Azure is unreachable for 3 checks in a row (and again when it recovers);
  - **a release regresses.** Every 10 minutes it looks for a new production release on each watched site (FE and API apart). 70 minutes after a release (its first hour, plus 10 minutes for App Insights to catch up), it runs the Release Verdict, comparing 1 hour before with 1 hour after. If the verdict is **Regressed**, the alert names the release time (SGT) and lists up to three metrics that got worse ("5xx rate 0.40% → 2.10%") and any new exception types. Releases from before the monitor started are never judged, each release is judged once, and a verdict that keeps failing is dropped 6 hours after the release. The check isn't kept across a restart, so a restart within that hour skips the release;
  - **a TLS certificate is close to expiry.** Once a day it runs the Cert & Domain Expiry check for the watched apps and alerts once per host when the certificate drops under 14 days left, and again when it expires. Hosts whose chain this machine can't trust are skipped. The alert state isn't kept across a restart, so a host that is still under 14 days alerts again after one.
- Each alert carries its numbers (peak values, time, averages). The Settings tab lists the exact thresholds.
- It also runs the **saved-query alerts** set up on Ask Telemetry (see there).
- Clicking an alert opens App Health Check reloaded to today, or Ask Telemetry for a saved-query alert. With the monitor on, closing the window keeps devForge in the tray; quit from the tray menu. devForge runs as a single instance: launching it again while it is open (or hidden in the tray) brings the existing window forward instead of starting a second copy.

Implementation: [electron/ipc/background-monitor.cjs](electron/ipc/background-monitor.cjs), [src/monitor/](src/monitor/)

---

## App shell

- **Sidebar**, grouped Monitoring / Web quality / Release / Utilities, with search. Click a group heading to collapse or expand it. Every group starts expanded and the choice is remembered; searching shows all matches regardless.
- **Authentication badges** at the foot of the sidebar: one badge each for Azure (CLI sign-in), Atlassian (Confluence API token and browser session, green only when both work) and Claude (Claude Code login; the badge reads `12% / 34% Claude`, your 5-hour session usage then weekly usage), colored by connection: green when signed in, amber when it can't be verified, red when it needs fixing, grey while checking or not set up. Hover for the exact state. They re-check every 5 minutes; the Azure poll reuses the cached token, so it starts no `az` process while the token is valid. Click a badge for a Re-check (for Azure this drops the cached tokens, so a fresh `az login` or another account takes effect at once); when one isn't signed in, the menu also shows the step-by-step sign-in guide and the fix (copy `az login` / `claude`, open Settings → Atlassian, create an API token). These badges replace the per-page Azure and Atlassian token pills, so every page shows them in one place. The Claude Code check reads the login on this machine (`~/.claude/.credentials.json`, or `CLAUDE_CONFIG_DIR`) through [electron/ipc/claude-usage.cjs](electron/ipc/claude-usage.cjs) and bills nothing. Implementation: [src/components/layout/sidebar-auth-status.tsx](src/components/layout/sidebar-auth-status.tsx)
- **Browser-style tabs.** Open tabs are restored on the next launch and stay mounted, so switching back keeps your inputs and results. Shortcuts: **Ctrl+Tab** / **Ctrl+Shift+Tab** to cycle, **Ctrl+W** to close, **Ctrl+1–8** to jump to a tab and **Ctrl+9** for the last one.
- **Command palette (Ctrl+K).** One search box for:
  - every page and Toolbox tool;
  - **Health Check: <app>** for each configured app, which opens App Health Check on that app for the last 6 hours, like a Home card;
  - every saved Ask Telemetry query, which opens Ask Telemetry and runs it, with no Claude call;
  - **Open Settings**.

  Matches use each page's keywords and description too. Press Ctrl+K again or Esc to close.
- **Settings**, **Release notes** and **auto-update** are covered in their sections below.

---

## Documentation

| Guide | Contents |
|-------|----------|
| [PageSpeed Insights](docs/pagespeed-insights.md) | Work instruction: API key setup, single / comparison / accuracy runs, reading results, Copy for Teams, Claude Analysis, fix briefs, history, troubleshooting. |

---

## Tech Stack

- **Runtime** — Electron 35, Node 20+
- **Frontend** — React 19, TypeScript, Vite (rolldown-vite), Tailwind CSS
- **UI** — Radix UI primitives, shadcn-style components, sonner toasts, recharts, `@tanstack/react-table`
- **Azure** — `@azure/identity`, `@azure/monitor-query` (App Service + Container Apps, Log Analytics)
- **Confluence** — runbook fetch via persisted browser session + Confluence Cloud REST; Release Runbook reads and writes the storage format (REST v1) and edits only the runbook tables
- **Markdown / capture** — `marked`, `html2canvas`
- **AI** — the [Claude CLI](https://docs.claude.com/en/docs/claude-code) (`claude -p`, your existing login) for RCA, PageSpeed analysis, the Unused Assets review, Ask Telemetry and App Investigation. Never the metered API. Calls that need no tools run lean (no tools, no plugins, hooks or MCP connectors, a short system prompt of their own), about 2k tokens of your plan instead of 50–70k
- **Testing** — Vitest + happy-dom
- **Auto-update** — `electron-updater` via GitHub Releases
- **Release automation** — GitHub Actions (`deploy.yml`): conventional commits → version tag → release build
- **Packaging** — `electron-builder` (NSIS / DMG / AppImage / deb)

---

## Getting Started

### Prerequisites

- Node.js 20 or newer
- npm 10+
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), signed in with `az login` — for App Health Check and the background monitor
- Optional: [Claude CLI](https://docs.claude.com/en/docs/claude-code) on PATH — for RCA, PageSpeed Claude Analysis, the Unused Assets review, Ask Telemetry and App Investigation

### Install

```bash
git clone https://github.com/jasonrosalinda/devforge.git
cd devforge
npm install
```

### Run in development

Two flavors:

```bash
npm run dev                  # Vite dev server only (browser preview)
npm run electron:dev:live    # Vite + Electron with HMR
```

`electron:dev:live` runs Vite at `http://localhost:5173` and launches Electron with hot reload — recommended for active development.

**Timing trace:** set `DEVFORGE_TRACE=1` before starting (PowerShell: `$env:DEVFORGE_TRACE=1; npm run electron:dev:live`) to log every outbound call (host and path, status, ms), every IPC handler's total time and every Azure token request (cache hit or miss) to the terminal. Headers, bodies and query strings are never logged. Implementation: [electron/ipc/trace.cjs](electron/ipc/trace.cjs)

---

## Build & Package

```bash
npm run electron:build    # Build production app + installer for current OS
npm run electron:pack     # Build without creating installer (unpacked dir)
npm run electron:release  # Build + publish to GitHub Releases (CI use)
```

Output lands in `release/`.

Targets configured in [electron-builder.json5](electron-builder.json5):
- **Windows**: NSIS installer + portable exe
- **macOS**: DMG + ZIP
- **Linux**: AppImage + deb

**Keep the installer small:** electron-builder copies every package in `dependencies` into `app.asar`. Only packages the Electron main process `require`s at runtime go in `dependencies` (today that is `@azure/identity`, `@azure/monitor-query` and `electron-updater`). Everything the frontend uses goes in `devDependencies`, because Vite already bundles it into `dist/`. Tests (`electron/**/*.test.mjs`) and non-English Chromium locales are excluded from the package.

---

## Release Workflow

Releases are automated from **conventional commits** by the repo-root workflow [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). It runs on every push to `main`.

### Commit convention

The bump is decided by scanning every commit since the last tag. The highest bump wins.

| Prefix | Version bump |
|--------|--------------|
| `fix:`, `perf:` | patch (1.2.0 → 1.2.1) |
| `feat:` | minor (1.2.0 → 1.3.0) |
| `feat!:` (any `type!:`) or `BREAKING CHANGE` in a message | major (1.2.0 → 2.0.0) |
| `chore:`, `docs:`, `refactor:`, `test:`, `style:`, `build:`, `ci:` | no release |

### Flow

1. Merge to `main`.
2. **deploy** builds the web version (`npm run build`) and publishes it to GitHub Pages.
3. **auto-tag** works out the bump from every commit since the last tag. It bumps from whichever is higher, `package.json` or the highest `v*` tag, so a tag made outside the workflow (for example, a release created in the GitHub UI) can't make it re-create an existing tag. It then runs `npm version`, commits `chore: release vX.Y.Z`, and pushes the commit and the `vX.Y.Z` tag.
4. **release**, on a Windows runner, generates release notes with [`.github/scripts/release-notes.mjs`](../.github/scripts/release-notes.mjs), then runs `npm run electron:build`. It uploads the installers and `latest*.yml` (for the auto-updater) to a GitHub Release.
   - **Notes content:** a summary line, sections by type (breaking changes first), one line per change with the first sentence of its commit body, PR and commit links, and an Install section with download links.
   - **Squash merges:** a squash merge that lists `* feat: …` items in its body gets one line per item.
   - **Dropped vs kept:** `chore:`, `ci:`, `test:`, `style:` and `build:` commits are left out, but a merged PR (`… (#12)`) is always kept.
   - **Format:** the notes use only the Markdown the in-app Release notes tab renders.
   - **Tests:** `node --test .github/scripts/release-notes.test.mjs`, which the job runs first.
5. Installed apps pick up the new version on their next launch (see Auto-Update).

---

## Auto-Update

On launch, installed (non-dev) builds query GitHub Releases for newer versions. Update lifecycle is surfaced through toasts:

- New version detected → "Downloading in background..."
- Download progress → live percent in a toast
- Download complete → persistent toast with **Restart Now** action
- Restart → `quitAndInstall()` applies the update

Implementation: [electron/main.cjs](electron/main.cjs), [src/hooks/useAppUpdater.ts](src/hooks/useAppUpdater.ts)

---

## Release Notes Viewer

Open **Settings → Release notes** (Settings is at the foot of the sidebar) to read the in-app release notes. It fetches releases from the GitHub API and renders the changelog inline — same content as the GitHub Releases page.

The theme (Light / Dark / System) is in **Settings → Appearance** and applies immediately, with no Save.

Implementation: [src/components/release-notes/release-notes-list.tsx](src/components/release-notes/release-notes-list.tsx)

---

## Project Structure

```
devforge/
├── index.html               # Main window entry
├── monitor.html             # Hidden background-monitor worker entry
├── electron/                # Main process + IPC handlers
│   ├── main.cjs             # App entry, BrowserWindow, auto-updater wiring
│   ├── preload.cjs          # contextBridge exposing electronAPI (main window + worker)
│   └── ipc/                 # Per-feature IPC modules
│       ├── azure-credential.cjs      # One shared, caching Azure credential (CLI first) for every module
│       ├── azure-metrics.cjs         # Azure Monitor / App Insights queries (page + monitor fetch)
│       ├── azure-config.cjs          # Config Diff: app setting / connection string names, values stay in main
│       ├── cert-expiry.cjs           # Cert & Domain Expiry: TLS handshake per app host
│       ├── trace.cjs                 # DEVFORGE_TRACE=1 timing log (fetch, IPC, tokens)
│       ├── azure-*.cjs               # SNAT, restarts, crash monitoring, page views, detectors, signals
│       ├── background-monitor.cjs    # Tray icon, hidden worker window, desktop notifications
│       ├── incident-report.cjs       # AI report + Claude RCA
│       ├── telemetry-ask.cjs         # Ask Telemetry: Claude-written KQL, run read-only on App Insights
│       ├── app-investigation.cjs     # App Investigation: scope guard, query interpreter, read-only repo agent
│       ├── pagespeed-insight.cjs     # Google PageSpeed API + Markdown report / fix brief
│       ├── unused-assets.cjs         # Unused CSS/JS scan + Claude review
│       ├── confluence.cjs            # Release runbook fetch (session + REST)
│       ├── claude-cli.cjs            # Shared Claude CLI spawning, read-only agent flags, git helpers
│       └── commands.cjs, ipapi.cjs, …
├── src/
│   ├── app.tsx              # App shell: sidebar, tabs, providers, modals
│   ├── pages/               # Top-level pages
│   ├── components/          # Feature + UI components (azure, pagespeed, toolbox, release-pilot, …)
│   ├── monitor/             # Background monitor worker: fetch loop + alert rules
│   ├── hooks/               # Custom hooks (useAppUpdater, useAzureMetrics, usePageTabs, …)
│   ├── services/            # External API clients (googleApi)
│   ├── lib/                 # Utilities (settings-store, page-tabs, parse-runbook, …)
│   ├── context/             # Settings providers
│   └── routes/              # Page registry
└── shared/                  # Types shared by main + renderer

.github/ (repo root)         # deploy.yml (Pages + tag + release), scripts/release-notes.mjs
```

---

## Configuration

Open the in-app **Settings** modal to configure:

- **Azure** — subscription ID + per-app entries (App Service or Container App, optional API + DB, optional network/edge diagnostics: Log Analytics workspace, App Gateway, Front Door, Load Balancer; optional **Incident file suffix** — ends the app's RCA file names, e.g. `MIMS-CPD` for medu and `MIMS-MSP` for msp; optional **App repository** / **API repository** — a local git clone or a GitHub URL that devForge clones itself; App Investigation reads it, never writes)
- **API Keys** — Google PageSpeed, UptimeRobot
- **Atlassian** — Confluence base URL, account email, API token (for Release Pilot)
- **Background monitor** — turn the tray monitor on and pick the apps to watch; lists what it watches and when it alerts

Settings are stored encrypted in the app's local storage, on this machine only (no cloud sync). Azure access comes from your `az login`, not from Settings.

---

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Vite dev server (browser only) |
| `npm run electron:dev:live` | Vite + Electron with HMR |
| `npm run electron:build` | Production installer for current OS |
| `npm run electron:pack` | Unpacked build (no installer) |
| `npm run electron:release` | Build + publish to GitHub Releases |
| `npm run lint` | ESLint over the codebase |
| `npm run typecheck` | `tsc --noEmit` type check |
| `npm run test` | Vitest unit tests |
| `npm run test:watch` | Vitest in watch mode |

---

## License

ISC
