# Spectra Copilot

<p align="right"><strong>English</strong> | <a href="README.md">中文</a></p>

<p align="center">
  <img src="assets/readme-hero.png" alt="Spectra Copilot: spectral curves, candidate materials, and a controlled Agent workflow" width="100%" />
</p>

### An auditable spectral-analysis Agent for materials, optics, and thermal-management research

From raw spectra to interpretable material decisions. Spectra Copilot is not a chat wrapper around calculator buttons: provide a research task and authorised data, and it understands the goal, requests missing conditions, orchestrates controlled local tools, and produces reproducible charts, rankings, and HTML reports.

> **The model decides what to do next; the Harness keeps data, calculations, and claims on a verifiable track.**

<p>
  <a href="https://spectra-copilot.onrender.com/"><strong>Live demo</strong></a> ·
  <a href="#a-three-minute-agent-workflow"><strong>3-minute workflow</strong></a> ·
  <a href="#agent-architecture"><strong>Architecture</strong></a> ·
  <a href="#run-locally"><strong>Run locally</strong></a>
</p>

> A local, tool-using spectral-analysis Agent for materials, optics, and thermal-management research.

---

## Project overview

Conventional spectral analysis often bounces between finding files, checking units, entering parameters, computing metrics, plotting, and assembling a report. Spectra Copilot turns this into a bounded research workflow:

- Give it a request such as: “Compare these samples in the solar band and 8–13 μm, identify candidates worth validating, and prepare a comparison figure and group-meeting report.”
- The Agent reads data summaries and asks only for genuinely missing physical conditions. It does not silently calculate before units, bands, or temperatures are confirmed.
- The LLM understands the task, chooses tools, and explains results. Deterministic code performs unit conversion, interpolation, integration, plotting, and export.
- Deliverables distinguish **tool facts**, **engineering judgements under explicit assumptions**, and **conditions that still require experimental validation**.

It is both a practical prototype for materials screening and a demonstration of how an Agent can combine natural-language interaction with controlled scientific computation.

## A three-minute Agent workflow

### Try the live demo

Open the [Spectra Copilot live demo](https://spectra-copilot.onrender.com/) — no installation required.

1. Select **Load candidate spectra**. Five public demo files appear as removable attachments; no task is submitted automatically.
2. Select **View recommended task** to review or edit the research request.
3. Select **Generate screening report** to see condition confirmation, tool traces, weighted calculations, a comparison chart, and an HTML report.
4. Open a chart or report in the right-hand preview and ask the Agent to revise it. Existing versions remain available.

The guided online run uses a controlled server-side allowance only for its bundled samples. For your own uploads, enter your own DeepSeek or OpenAI-compatible API key in **AI Settings**. The public site never scans a visitor’s computer; uploads and generated artifacts are held only temporarily in runtime memory.

### What you can inspect

| Stage | What the Agent does | What remains auditable |
| --- | --- | --- |
| Data intake | Reads file summaries and checks columns, candidate units, ranges, and spectral coverage | Authorised file scope and unconfirmed conditions |
| Context building | Combines statements such as “this is reflectance”, “3–5 μm”, and “300 K” | Calculation assumptions and unanswered questions |
| Tool orchestration | Selects the smallest necessary set of summary, audit, weighting, plotting, and report tools | Live tool trace and structured result summaries |
| Decision delivery | Ranks candidates and creates figures/reports from real data | Metrics, charts, assumptions, limitations, and suggested next steps |

## Research tasks it supports

| Research task | How the Agent works | Primary deliverables |
| --- | --- | --- |
| **Radiative-cooling candidate screening** | Checks solar-band and atmospheric-window coverage; after semantic confirmation, calculates ASTM G173 or blackbody-weighted metrics | Weighted metrics, ranking, charts, and validation conditions |
| **Infrared radiation / stealth candidate comparison** | Extracts peaks, valleys, averages, and trends in user-specified bands; checks whether reflectance can imply emissivity under opaque or known-transmittance assumptions | Band-feature table, comparison chart, and qualified engineering interpretation |
| **Optical coating and material selection** | Checks common coverage, units, and Y-axis semantics before comparing samples | Comparability check, selection rationale, real multi-curve figure |
| **Instrument-data intake and debugging** | Identifies delimiters, headers, invalid rows, duplicate wavelengths, outliers, and unit candidates; audits raw rows when needed | Data-quality summary, anomaly locations, and pending confirmations |
| **Group meeting, defense, or paper-style reporting** | Collects tool facts before creating an HTML report with real spectra, methods, results, AI interpretation, and limitations | Browser-printable HTML report |
| **Next-experiment planning** | Uses existing coverage and results to propose missing bands, temperatures, or controls | Evidence-bounded experimental suggestions, not invented mechanisms |

<a id="agent-architecture"></a>

## Agent architecture: more than a calculator

| Layer | Current responsibility | Explicitly does not do |
| --- | --- | --- |
| **LLM research-collaboration layer** | Understands natural-language goals, merges context, chooses tools, asks necessary questions, explains results, and structures reports | Does not mentally integrate spectra or invent numerical values from memory or images |
| **Agent Harness** | Routes intent, manages session memory, enforces permission and condition gates, runs the tool loop, records execution, and versions deliverables | Does not let the model read unauthorised files or freely recreate prior artifacts |
| **Deterministic spectral-tool layer** | Parses data, checks quality, converts units, interpolates, calculates band features and ASTM/blackbody weights, plots, reports, and exports | Does not alter source data or present recommendations as experimental facts |

**The model decides what to do; code establishes what is true and whether the action is allowed.**

```text
Natural-language research task + authorised spectra
                    ↓
LLM: understand, plan, choose tools, ask, explain
                    ↕
Harness: context / permissions / condition gates / trace / artifact versions
                    ↕
Deterministic tools: parse, calculate, plot, report, export
                    ↓
Reproducible figures, tables, material comparisons, recommendations, reports
```

## Toolset and capability map

Tools are invoked only when the task needs them. A normal question does not automatically trigger calculations or files.

| Capability | Current tool | Purpose |
| --- | --- | --- |
| Authorised file understanding | `get_selected_spectrum_summaries` | Reads summaries, point counts, candidate units, ranges, and warnings inside the user-approved scope |
| Raw-data audit | `scan_raw_spectrum_rows` | Locates up to 30 raw X/Y rows around thresholds, extrema, or anomalies, with approximate source row numbers |
| Semantic context and memory | `update_task_context`, `confirm_spectrum_meanings` | Interprets conditions such as “300 K”, “the previous range”, and “all are reflectance” into structured state |
| Project-method lookup | `get_legacy_demo_contract` | Reads in-project ASTM, plotting, and integration conventions rather than relying on model memory |
| Spectral-feature analysis | `summarize_band_features` | Computes means, extrema, extrema locations, and trends within selected bands |
| Physics-weighted calculation | `calculate_weighted_metrics` | Uses ASTM G173 AM1.5G for nm data; uses Planck blackbody weighting and trapezoidal integration for μm/wavenumber data |
| Scientific visualisation | `generate_spectrum_chart`, `generate_comparison_chart` | Creates single- or multi-sample figures from source points with band annotations |
| Report and web deliverables | `generate_screening_report`, `generate_analysis_report`, `generate_custom_html_deliverable` | Produces multi-material screening, single-sample, or custom HTML reports with real figures and tool facts |
| Traceable revision | `read_current_artifact`, `patch_current_html_artifact` | Uses `@artifact` to lock a revision target and creates only its next version |
| Data export | `/api/weighted-export` | Exports existing weighted results to CSV or Excel |

See [ARCHITECTURE.md](ARCHITECTURE.md) for intent routing, memory, tool boundaries, and evaluation principles.

## How a task is completed

1. **Receive data and task** — Search within Desktop in local mode, or upload CSV, TXT, TSV, DPT, or XLSX spectra; a task supports up to 30 files.
2. **Build trusted context** — Check delimiters, headers, invalid rows, duplicate wavelengths, sorting, Y-value ranges, band coverage, and candidate units. Physical calculations require confirmed units and semantics.
3. **Use the minimum necessary tools** — Start with summaries; inspect raw rows only when needed; then calculate features, weighted metrics, figures, or reports.
4. **Enforce the Harness boundary** — Pause for missing bands, temperatures, or confirmations. The current tool loop defaults to five rounds to limit runaway cost.
5. **Deliver evidence and preserve it** — The chat exposes a public tool trace. Figures, reports, and exports are based on deterministic outputs. Revising `@chart` or `@report` creates only the next version of that artifact.

## Trust, privacy, and limitations

- **No LLM mental arithmetic** — Unit conversion, interpolation, ASTM/blackbody weighting, trapezoidal integration, CSV/Excel handling, and plotting data are deterministic.
- **No silent data modification** — Automatic unit recognition is a candidate hint; cleaning, conversion, or a physical conclusion requires appropriate confirmation.
- **Minimal model context** — The model normally receives filenames, summaries, confirmation state, and calculated results. Raw rows are supplied only for explicit debugging, and at most 30 authorised rows are exposed.
- **Separated claims** — Reports separate tool facts, AI interpretation, research advice, limitations, and unresolved conditions. Correlation is not written as a proven mechanism.
- **Transparent failures** — When the model service fails, coverage is inadequate, or conditions are missing, the app explains why, keeps any valid artifacts, and supports retry rather than faking success.
- **Keys stay out of the repository** — In the online version, user keys are retained only in the current browser tab. In local mode, browser storage retains the profile until it is cleared in **AI Settings**. Server-side demo keys never enter Git, client JavaScript, or logs.

This project is not a medical, production-safety, or legal decision tool. Researchers must review source data, experimental conditions, and physical assumptions before using a conclusion.

## Run locally

### Requirements

- Node.js 20 or later
- macOS, Windows, or Linux
- Optional: a DeepSeek or OpenAI-compatible API key. Without one, local rules, file reading, and some deterministic functions still work.

### Start from the command line

```bash
git clone https://github.com/1178922523-maker/spectra-copilot.git
cd spectra-copilot
npm install
npm test
npm start
```

Then open <http://127.0.0.1:8787>.

### macOS quick start

1. Install Node.js 20 or later from <https://nodejs.org/>.
2. Double-click `启动光谱Agent.app` (recommended). When the terminal prints `Spectra Copilot 已启动`, open <http://127.0.0.1:8787>.
3. If macOS blocks the unsigned app on first launch: choose “Done”, Control-click the app, choose “Open”, then choose “Open” again in the confirmation dialog.

<details>
<summary>Fallback: start with Terminal</summary>

1. In Finder, open the project folder. Right-click empty space and choose Services → New Terminal at Folder.
2. Type `bash` followed by one space, then drag `启动光谱Agent.command` into the terminal to insert its full path.
3. Press Return. The first start installs dependencies and requires network access.

The command will look like:

```bash
bash "/full/path/光谱计算Agent/启动光谱Agent.command"
```

If Finder does not show “New Terminal at Folder”, open Terminal, type `cd` followed by one space, drag the project folder into the terminal, press Return, then continue with step 2.
</details>

### Windows

1. Install Node.js 20 or later from <https://nodejs.org/>.
2. Double-click `启动光谱Agent-Windows.bat`.
3. Open <http://127.0.0.1:8787> after the terminal prints the start message.

## Deploy online

The repository includes a Dockerfile and can run on Render, Railway, Fly.io, Google Cloud Run, and similar platforms.

```bash
SPECTRA_MODE=public PORT=10000 npm start
```

Public mode accepts only explicit uploads and never scans visitors’ computers. Read [DEPLOYMENT.md](DEPLOYMENT.md) before deployment. It covers low-quota server-side demo keys for bundled interview samples and why keys must never be placed in code or a README.

## Repository map

```text
assets/光谱计算器（最终版）.html  # bundled legacy calculator and ASTM data
assets/readme-hero.png            # README hero illustration
server.mjs                        # HTTP service, controlled tools, and Agent loop
src/spectral-core.js              # reusable, tested deterministic calculation/QA core
src/app.js                        # browser workspace and Agent workflow
src/styles.css                    # responsive visual system
ARCHITECTURE.md                   # Agent architecture, routing, memory, tool boundaries
DEPLOYMENT.md                     # public demo deployment and quota notes
tests/                            # automated tests
启动光谱Agent.app/                # unsigned macOS convenience launcher
LICENSE                           # MIT license
CONTRIBUTING.md                   # contribution conventions
SECURITY.md                       # security boundary and reporting process
```

## Contributing

Issues and pull requests are welcome:

- 🐛 **Report a bug** — include reproduction steps, de-identified data characteristics, and expected versus actual behaviour.
- 💡 **Suggest an improvement** — discuss tools, instrument formats, physical metrics, or workflow design.
- 🛠️ **Contribute code** — run `npm test` before submitting. Never commit API keys, restricted experimental data, or generated artifacts containing sensitive content.
- 🔒 **Report a security issue** — follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Roadmap

1. Add a cleaning and resampling preview: sorting, duplicate-point handling, and anomaly annotations must be confirmed before new data are exported.
2. Add A/T/R energy-conservation checks, multi-file comparability checks, deterministic screening, and uncertainty analysis.
3. Add paper-grade multi-panel figures, reproducible chart themes, and repeated-measurement statistics.
4. Before broad public productisation, add user isolation, run checkpoints, queues, resumable execution, and usage audit; then consider a Tauri/Electron desktop connector.

## License and third-party content

Original code in this repository is released under the [MIT License](LICENSE). Third-party dependencies and bundled legacy resources retain their own licences and notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

If Spectra Copilot is useful for your research, learning, or interview portfolio, a Star, issue, or shared spectral-analysis workflow is always appreciated.
