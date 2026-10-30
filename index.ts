/**
 * Ollama quota extension for Pi.
 *
 * Shows Ollama Cloud quota usage right-aligned on the footer's path line:
 * progress bar, used %, $allowance, quota reset time and burn rates (%/h over
 * 3 h and %/min over 60 min). Wraps Pi's built-in FooterComponent, so token
 * stats, context %, git branch and other extensions' statuses keep working.
 *
 * Commands:
 *   /ollama-usage [24h|7d|30d]              detailed usage report
 *   /ollama-usage-config [option] [on|off] list or toggle every visual option
 *   /ollama-usage-widget [on|off]          shorthand for the widget option
 *
 * Data comes from the unofficial https://ollama.com/api/balance and
 * /api/usage endpoints using the ollama-cloud provider credentials (or
 * OLLAMA_API_KEY).
 *
 * Environment:
 *   PI_OLLAMA_USAGE_STATUS=0        force the footer usage line off
 *   PI_OLLAMA_USAGE_WIDGET=1        force the detailed widget on
 *   PI_OLLAMA_USAGE_REFRESH_MS=...  refresh interval in ms (default 5 min)
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { getApiKey, getBalance, getStats, parseRange, type Balance, type Snapshot, type UsageStats } from "./api.ts";
import { createFooterComponent } from "./footer.ts";
import {
	configSummary,
	findBooleanOption,
	loadVisualOptions,
	parseIcon,
	parsePlacement,
	parseToggle,
	saveOptionKey,
	type ConfigName,
	type IconName,
	type Placement,
	type VisualOptions,
} from "./options.ts";
import { iconGlyph, reportLines, statusText, widgetLines } from "./render.ts";

const STATUS_KEY = "ollama-usage-pct";
const WIDGET_KEY = "ollama-usage-widget";
const DEFAULT_REFRESH_MS = 5 * 60_000;

function envInt(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

export default function ollamaQuotaExtension(pi: ExtensionAPI) {
	const refreshMs = envInt("PI_OLLAMA_USAGE_REFRESH_MS", DEFAULT_REFRESH_MS);

	let ctxRef: ExtensionContext | undefined;
	// Loaded lazily and re-read on every session start so project overrides and
	// edits on disk take effect without restarting Pi.
	let options: VisualOptions | undefined;
	const optionsContext = (ctx: ExtensionContext) => ({ agentDir: getAgentDir(), cwd: ctx.cwd });
	const getOptions = (): VisualOptions => {
		if (!options) {
			options = loadVisualOptions({ agentDir: getAgentDir(), cwd: ctxRef?.cwd ?? process.cwd() });
		}
		return options;
	};

	let snapshot: Snapshot | undefined;
	let lastError: string | undefined;
	let lastAttemptAt = 0;
	let inflight = false;
	let generation = 0;
	let timer: ReturnType<typeof setInterval> | null = null;
	let footerInstalled = false;
	let footerTui: { requestRender(): void } | undefined;
	let footerFallback = false;

	const isCloud = (ctx: ExtensionContext) => ctx.model?.provider === "ollama-cloud";

	function usageLine(theme: Theme, compact = false): string | undefined {
		const settings = getOptions();
		if (snapshot) return statusText(theme, snapshot, settings, compact);
		const glyph = iconGlyph(settings.icon) || "☁";
		if (lastError) return theme.fg("error", `${glyph} monitor n/a`);
		return theme.fg("dim", `${glyph} monitor …`);
	}

	/**
	 * Install a custom footer that wraps Pi's built-in FooterComponent and puts
	 * the usage line at the top right, on the same line as the project path.
	 */
	function installFooter(ctx: ExtensionContext) {
		if (footerInstalled) return;
		footerInstalled = true;
		ctx.ui.setFooter((tui, theme, footerData) =>
			createFooterComponent({
				getContext: () => ctxRef ?? ctx,
				footerData,
				theme,
				tui,
				usage: (usageTheme, compact) => usageLine(usageTheme, compact),
				onTui: (footerTuiRef) => {
					footerTui = footerTuiRef;
				},
				onDispose: () => {
					footerTui = undefined;
					footerInstalled = false;
				},
			}),
		);
	}

	function removeFooter(ctx: ExtensionContext) {
		if (!footerInstalled) return;
		ctx.ui.setFooter(undefined);
		footerInstalled = false;
		footerTui = undefined;
	}

	function render() {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return;
		const settings = getOptions();

		const visible = isCloud(ctx) && ctx.hasUI;
		const useStatusLine = settings.placement === "status" || footerFallback;

		if (!settings.footer || !visible) {
			removeFooter(ctx);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} else if (!useStatusLine) {
			try {
				installFooter(ctx);
				// Drop any status-line fallback left behind on earlier runs/reloads.
				ctx.ui.setStatus(STATUS_KEY, undefined);
				footerTui?.requestRender();
			} catch {
				// Custom footer unavailable: fall back to the plain status line.
				footerFallback = true;
				ctx.ui.setStatus(STATUS_KEY, usageLine(ctx.ui.theme));
			}
		} else {
			removeFooter(ctx);
			ctx.ui.setStatus(STATUS_KEY, usageLine(ctx.ui.theme));
		}

		const widgetHasContent =
			settings.bar || settings.percent || settings.dollars || settings.reset || settings.rate || settings.rateMin;
		if (settings.widget && visible && snapshot && widgetHasContent) {
			// Recreate on each update so colors follow the active theme.
			ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					return widgetLines(theme, snapshot as Snapshot, getOptions()).map((line) =>
						truncateToWidth(line, width),
					);
				},
			}));
		} else {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	}

	async function refresh(options: { force?: boolean } = {}): Promise<void> {
		const ctx = ctxRef;
		if (!ctx || !isCloud(ctx) || inflight) return;
		if (!options.force && Date.now() - lastAttemptAt < refreshMs) return;

		inflight = true;
		lastAttemptAt = Date.now();
		const gen = generation;

		try {
			const key = await getApiKey(ctx);
			if (!key) throw new Error("no Ollama Cloud API key (set OLLAMA_API_KEY or auth.json)");
			const balance = await getBalance(key);

			let stats = snapshot?.stats;
			let statsFetchedAt = snapshot?.statsFetchedAt;
			try {
				stats = await getStats(key, "24h");
				statsFetchedAt = Date.now();
			} catch {
				// Burn rate is best-effort; keep the previous buckets (if still fresh).
			}
			if (gen !== generation) return;
			snapshot = { balance, stats, statsFetchedAt, fetchedAt: Date.now() };
			lastError = undefined;
		} catch (err) {
			if (gen !== generation) return;
			lastError = err instanceof Error ? err.message : String(err);
		} finally {
			inflight = false;
			if (gen === generation) render();
		}
	}

	function startTimer() {
		stopTimer();
		timer = setInterval(() => {
			void refresh();
		}, refreshMs);
	}

	function stopTimer() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	function teardown(ctx: ExtensionContext) {
		generation++;
		stopTimer();
		removeFooter(ctx);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctxRef = undefined;
		inflight = false;
	}

	// --- Lifecycle ---

	pi.on("session_start", (_event, ctx) => {
		generation++;
		ctxRef = ctx;
		// Re-read options so project overrides and manual edits apply per session.
		options = undefined;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		startTimer();
		if (isCloud(ctx)) void refresh({ force: true });
	});

	pi.on("model_select", (_event, ctx) => {
		ctxRef = ctx;
		render();
		if (isCloud(ctx)) void refresh();
	});

	pi.on("agent_end", (_event, ctx) => {
		ctxRef = ctx;
		// Throttled inside refresh(): at most one fetch per refresh interval.
		if (isCloud(ctx)) void refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		teardown(ctx);
	});

	// --- Commands ---

	pi.registerCommand("ollama-usage", {
		description: "Show Ollama Cloud usage allowance and request stats (range: 24h, 7d, 30d).",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const range = parseRange(args);
			if (!range) {
				ctx.ui.notify(`Unknown range "${args.trim()}". Usage: /ollama-usage [24h|7d|30d]`, "error");
				return;
			}

			const key = await getApiKey(ctx);
			if (!key) {
				ctx.ui.notify("No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add it to auth.json.", "error");
				return;
			}

			let balance: Balance;
			try {
				balance = await getBalance(key);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Ollama Cloud usage failed: ${message}`, "error");
				return;
			}

			snapshot = {
				balance,
				stats: snapshot?.stats,
				statsFetchedAt: snapshot?.statsFetchedAt,
				fetchedAt: Date.now(),
			};
			lastError = undefined;
			lastAttemptAt = Date.now();
			render();

			let stats: UsageStats | undefined;
			let statsError: string | undefined;
			try {
				stats = await getStats(key, range);
			} catch (err) {
				statsError = err instanceof Error ? err.message : String(err);
			}

			ctx.ui.notify(reportLines(ctx.ui.theme, snapshot, getOptions(), stats).join("\n"), "info");
			if (statsError) ctx.ui.notify(`Ollama Cloud ${range} stats unavailable: ${statsError}`, "warning");
		},
	});

	/** Persist one option, apply it in memory, and re-render. */
	function applyOption(
		ctx: ExtensionContext,
		key: ConfigName,
		value: boolean | Placement | IconName,
		message: string,
	) {
		const settings = getOptions();
		if (key === "placement") settings.placement = value as Placement;
		else if (key === "icon") settings.icon = value as IconName;
		else settings[key] = value as boolean;

		const saved = saveOptionKey(optionsContext(ctx), key, value);
		ctxRef = ctx;
		render();
		const suffix = saved.error ? ` (not saved: ${saved.error})` : "";
		ctx.ui.notify(`${message}${suffix}`, saved.error ? "warning" : "info");
	}

	pi.registerCommand("ollama-usage-config", {
		description: "Toggle Ollama quota visuals (footer, bar, percent, rate, rateMin, reset, dollars, updated, widget, placement, icon).",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const [rawName, rawValue] = args.trim().split(/\s+/);
			const name = (rawName ?? "").toLowerCase();
			const settings = getOptions();

			if (!name) {
				ctx.ui.notify(configSummary(settings), "info");
				return;
			}

			if (name === "icon") {
				const next = parseIcon(rawValue);
				if (next === undefined) {
					ctx.ui.notify("Usage: /ollama-usage-config icon llama|cloud|none", "error");
					return;
				}
				applyOption(ctx, "icon", next, `icon: ${next}`);
				return;
			}

			if (name === "placement") {
				const next = parsePlacement(rawValue);
				if (next === undefined) {
					ctx.ui.notify("Usage: /ollama-usage-config placement path|status", "error");
					return;
				}
				applyOption(ctx, "placement", next, `placement: ${next}`);
				return;
			}

			const key = findBooleanOption(name);
			if (!key) {
				ctx.ui.notify(`Unknown option "${rawName}".\n\n${configSummary(settings)}`, "error");
				return;
			}

			const next = parseToggle(rawValue ?? "", settings[key]);
			if (next === undefined) {
				ctx.ui.notify(`Usage: /ollama-usage-config ${key} [on|off]`, "error");
				return;
			}
			applyOption(ctx, key, next, `${key}: ${next ? "on" : "off"}`);
		},
	});

	pi.registerCommand("ollama-usage-widget", {
		description: "Toggle the Ollama Cloud usage widget above the editor (on/off, default: toggle).",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const settings = getOptions();
			const next = parseToggle(args, settings.widget);
			if (next === undefined) {
				ctx.ui.notify(`Unknown argument "${args.trim()}". Usage: /ollama-usage-widget [on|off]`, "error");
				return;
			}
			applyOption(ctx, "widget", next, `widget: ${next ? "on" : "off"}`);
		},
	});
}
