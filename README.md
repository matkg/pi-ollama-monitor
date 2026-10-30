# pi-ollama-monitor

Ollama Cloud **quota** monitor for the [Pi](https://pi.dev) coding agent: a
progress bar, used percentage, remaining dollar allowance, the exact quota
reset time, and burn rates — right-aligned on the footer's path line.

```
~/cleanframe-bravia (main)     🦙 monitor ████░░░░░░ 41% resets 8. Nov. 19:59 · 2.7%/h · 0.05%/min
12.5%/200k (auto)                              (ollama-cloud) deepseek-v4.1-flash • high
```

- **Top right, not another line.** Wraps Pi's built-in `FooterComponent`, so
  token stats, context %, git branch, session name and other extensions'
  statuses keep working. No patching of Pi or third-party TUIs.
- **Dollars, not just percentages.** Reads the monthly plan allowance from
  `/api/balance` (e.g. `$36 of $60 left`).
- **Burn rates.** `%/h` averaged over the last 3 hours and `%/min` averaged
  over the last 60 minutes, derived from the hourly `/api/usage` buckets.
- **Reset time.** Shows when the quota refills, in local time.
- **Everything togglable and persisted** — see [Options](#options).
- **Degrades gracefully.** No key, API error, no allowance, stale stats or a
  narrow terminal never break the footer.

## Install

```bash
pi install npm:pi-ollama-monitor
```

or from git:

```bash
pi install git:github.com/mattKg/pi-ollama-monitor
```

Requires Pi with a version that exports `FooterComponent` (pi ≥ 1.4). On older
versions the extension falls back to a plain status line.

## Authentication

The extension resolves your Ollama Cloud key in this order:

1. Pi provider auth — `/login ollama` or an `ollama-cloud` entry from
   [pi-ollama-cloud](https://github.com/fgrehm/pi-ollama-cloud)
2. `OLLAMA_API_KEY` environment variable
3. `~/.pi/agent/auth.json` → `{ "ollama-cloud": { "type": "api_key", "key": "..." } }`

Create a key at [ollama.com/settings/keys](https://ollama.com/settings/keys).

## Commands

| Command | Description |
|---|---|
| `/ollama-usage [24h\|7d\|30d]` | Full report: quota bar, allowance, renewal, requests/spend/tokens, both burn rates and a "runs out in ~…" projection |
| `/ollama-usage-config [option] [on\|off]` | List or toggle every visual option |
| `/ollama-usage-widget [on\|off]` | Shorthand for the `widget` option |

## Options

Options persist in `~/.pi/agent/ollama-usage.json`; a project file in
`.pi/ollama-usage.json` overrides it. Toggle them at runtime:

```bash
/ollama-usage-config                 # list current state
/ollama-usage-config bar off         # toggle or set
/ollama-usage-config icon cloud
/ollama-usage-config placement status
```

| Option | Default | Effect |
|---|---|---|
| `footer` | `on` | Usage line in the footer |
| `placement` | `path` | `path` = top-right on the path line, `status` = plain status line below |
| `icon` | `llama` | `llama` (🦙), `cloud` (☁) or `none` |
| `bar` | `on` | ASCII progress bar |
| `percent` | `on` | Used percentage |
| `rate` | `on` | Burn rate over the last 3 hours (`%/h`) |
| `rateMin` | `on` | Burn rate over the last 60 minutes (`%/min`) |
| `reset` | `on` | Quota reset date and time |
| `dollars` | `off` | Remaining allowance (`$balance/$allowance`) |
| `updated` | `off` | Time of the last successful refresh |
| `widget` | `off` | Detailed usage line above the editor |

`/ollama-usage` always shows the full detail regardless of these toggles.

### Environment overrides

| Variable | Effect |
|---|---|
| `PI_OLLAMA_USAGE_STATUS=0` | Force the footer usage line off |
| `PI_OLLAMA_USAGE_WIDGET=1` | Force the widget on |
| `PI_OLLAMA_USAGE_REFRESH_MS` | Poll interval in ms (default `300000` = 5 min) |

## How it works

- **Polling:** balance + 24 h usage on session start, at most once per 5 min
  while the session is open, and after a turn (throttled). `/ollama-usage`
  refreshes immediately.
- **Rate math:** each `/api/usage` bucket is weighted by its overlap with the
  trailing window (3 h or 60 min). `%/h` and `%/min` are percentage points of
  the plan allowance consumed per unit of time. Rates are omitted when the
  stats are older than 15 min, when the account has no dollar allowance, or
  when there is no recent usage.
- **Quota windows:** accounts with rolling windows (5 h / 7 d / 30 d) show one
  label per window; accounts with a monthly dollar allowance show a single
  `plan` segment. Both shapes are supported.

## Compatibility note

`/api/balance` and `/api/usage` are unofficial endpoints. The extension
validates their shape and hides the line on errors. The top-right placement
wraps Pi's exported `FooterComponent`, whose session surface is not a public
type; the render path is guarded and falls back to `placement: status` if the
shape changes. Pin your Pi version if this matters to you.

## Development

```bash
node --test test/api.test.ts test/options.test.ts test/render.test.ts
```

The API/quota math, option handling and every render surface are covered by
`node:test`; no build step is required (Pi loads the TypeScript directly).

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
— source-available, not open source in the OSI sense:

- ✅ use, modify and redistribute for **noncommercial purposes**
- ❌ **commercial use** (including use by a for-profit company in its business)
- ✅ provided **as is**, without warranty; the licensor is **not liable** for damages
- redistributions must include the license terms and the `Required Notice:` line

For commercial licensing, contact the author.
