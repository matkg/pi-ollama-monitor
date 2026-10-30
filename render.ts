/**
 * Rendering for the Ollama quota extension.
 *
 * `composeParts()` is the single source of truth for *what* is shown; the
 * footer, widget and report renderers only decide *how* to lay it out. This
 * keeps option toggles consistent across all surfaces.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	RATE_MIN_WINDOW_MINUTES,
	RATE_WINDOW_HOURS,
	limitSegments,
	nextResetIso,
	usageRatePerHour,
	usageRatePerMinute,
	type Segment,
	type Snapshot,
	type UsageStats,
} from "./api.ts";
import type { IconName, VisualOptions } from "./options.ts";

// --- Formatting helpers ---

export function fmtInt(value: number): string {
	return value.toLocaleString("en-US");
}

export function fmtTokens(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function fmtClock(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Compact age of a fetch, e.g. "12s", "3m", "2h 5m". */
export function fmtAge(ms: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - ms) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return hours < 48 ? `${hours}h ${rest}m` : `${Math.floor(hours / 24)}d`;
}

export function fmtCountdown(iso: string | undefined, now = Date.now()): string {
	if (!iso) return "";
	const target = Date.parse(iso);
	if (Number.isNaN(target)) return "";
	const diff = target - now;
	if (diff <= 0) return "expired";
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `in ${hours}h ${minutes % 60}m`;
	return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatDuration(hours: number): string {
	if (!Number.isFinite(hours)) return "never";
	const totalMinutes = Math.round(hours * 60);
	if (totalMinutes < 60) return `${Math.max(1, totalMinutes)}m`;
	const days = Math.floor(totalMinutes / (24 * 60));
	const restHours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const restMinutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${restHours}h`;
	return restMinutes > 0 ? `${restHours}h ${restMinutes}m` : `${restHours}h`;
}

export function colorFor(used: number): "success" | "warning" | "error" {
	return used >= 80 ? "error" : used >= 60 ? "warning" : "success";
}

export function bar(theme: Theme, used: number, width = 10): string {
	const filled = Math.min(Math.max(Math.round((used / 100) * width), 0), width);
	return theme.fg(colorFor(used), `${"█".repeat(filled)}${"░".repeat(width - filled)}`);
}

export function money(amount: number): string {
	return `$${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2)}`;
}

export function formatRate(rate: number): string {
	if (rate < 0.05) return "<0.1%/h";
	return `${rate < 10 ? rate.toFixed(1) : Math.round(rate).toString()}%/h`;
}

export function formatRatePerMinute(rate: number): string {
	if (rate <= 0) return "0.00%/min";
	if (rate < 0.005) return "<0.01%/min";
	return `${rate.toFixed(2)}%/min`;
}

/** Local reset time, e.g. "Nov 8 20:59" (year added when it differs). */
export function fmtReset(iso: string, now = new Date()): string {
	const date = new Date(iso);
	const sameYear = date.getFullYear() === now.getFullYear();
	const day = date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(sameYear ? {} : { year: "numeric" }),
	});
	return `${day} ${fmtClock(date.getTime())}`;
}

/** The emoji/symbol shown before "monitor" (empty string when disabled). */
export function iconGlyph(icon: IconName): string {
	if (icon === "llama") return "🦙";
	if (icon === "cloud") return "☁";
	return "";
}

function percentText(theme: Theme, segments: Segment[]): string {
	return segments
		.map((segment) =>
			segment.short === "plan"
				? theme.fg(colorFor(segment.used), `${segment.used}%`)
				: `${theme.fg("muted", segment.short)} ${theme.fg(colorFor(segment.used), `${segment.used}%`)}`,
		)
		.join(theme.fg("dim", " · "));
}

// --- Shared composition ---

export interface VisualParts {
	segments: Segment[];
	bar: boolean;
	percent: boolean;
	/** "$35.79/$60" */
	dollars?: string;
	/** "Nov 8 20:59" */
	reset?: string;
	/** "22:18" */
	updated?: string;
	/** Formatted burn rates, e.g. ["2.7%/h", "0.05%/min"]. */
	rates: string[];
}

/**
 * Collect every enabled visual field for a snapshot. Returns undefined when
 * there is no quota information to show.
 */
export function composeParts(snapshot: Snapshot, options: VisualOptions): VisualParts | undefined {
	const segments = limitSegments(snapshot.balance);
	if (segments.length === 0) return undefined;

	const parts: VisualParts = { segments, bar: options.bar, percent: options.percent, rates: [] };

	const included = snapshot.balance.included;
	if (
		options.dollars &&
		included &&
		typeof included.balance_usd === "number" &&
		typeof included.allowance_usd === "number" &&
		included.allowance_usd > 0
	) {
		parts.dollars = `${money(included.balance_usd)}/${money(included.allowance_usd)}`;
	}

	if (options.reset) {
		const reset = nextResetIso(snapshot);
		if (reset) parts.reset = fmtReset(reset);
	}

	if (options.updated) parts.updated = fmtClock(snapshot.fetchedAt);

	if (options.rate) {
		const rate = usageRatePerHour(snapshot);
		if (rate !== undefined) parts.rates.push(formatRate(rate));
	}
	if (options.rateMin) {
		const rate = usageRatePerMinute(snapshot);
		if (rate !== undefined) parts.rates.push(formatRatePerMinute(rate));
	}

	return parts;
}

// --- Surfaces ---

/** One-line footer status. `compact` drops everything after bar + percentage. */
export function statusText(
	theme: Theme,
	snapshot: Snapshot,
	options: VisualOptions,
	compact = false,
): string | undefined {
	const parts = composeParts(snapshot, options);
	if (!parts) return undefined;

	const worst = Math.max(...parts.segments.map((segment) => segment.used));
	const glyph = iconGlyph(options.icon);
	const out: string[] = [theme.fg(worst >= 80 ? "error" : "accent", glyph ? `${glyph} monitor` : "monitor")];

	if (parts.bar) out.push(bar(theme, worst));
	if (parts.percent) out.push(percentText(theme, parts.segments));

	// Compact variant: drop the long trailing fields to keep the path usable.
	if (compact) return out.length > 1 ? out.join(" ") : undefined;

	if (parts.dollars) out.push(theme.fg("dim", parts.dollars));
	if (parts.reset) out.push(theme.fg("dim", `resets ${parts.reset}`));
	if (parts.updated) out.push(theme.fg("dim", `upd ${parts.updated}`));

	if (parts.rates.length > 0) {
		const separator = parts.reset || parts.updated ? "· " : "";
		out.push(theme.fg("dim", `${separator}${parts.rates.join(theme.fg("dim", " · "))}`));
	}

	return out.length > 1 ? out.join(" ") : undefined;
}

/** One-line widget above the editor. */
export function widgetLines(theme: Theme, snapshot: Snapshot, options: VisualOptions): string[] {
	const parts = composeParts(snapshot, options);
	if (!parts) return [];

	const chunks: string[] = [];

	if (parts.bar || parts.percent) {
		const perSegment = parts.segments
			.map((segment) => {
				const label = segment.short === "plan" ? "" : `${theme.fg("muted", segment.short)} `;
				const barText = parts.bar ? `${bar(theme, segment.used)} ` : "";
				const percent = parts.percent ? theme.fg(colorFor(segment.used), `${segment.used}%`) : "";
				return `${label}${barText}${percent}`.trim();
			})
			.join("  ");
		if (perSegment) chunks.push(perSegment);
	}

	if (parts.dollars) chunks.push(theme.fg("dim", `${parts.dollars} left`));
	if (parts.reset) chunks.push(theme.fg("dim", `resets ${parts.reset}`));
	if (parts.updated) chunks.push(theme.fg("dim", `upd ${parts.updated}`));
	for (const rate of parts.rates) chunks.push(theme.fg("dim", rate));

	if (chunks.length === 0) return [];
	const glyph = iconGlyph(options.icon);
	const label = glyph ? `${glyph} monitor` : "monitor";
	return [`${theme.fg("accent", label)}  ${chunks.join(theme.fg("dim", "  ·  "))}`];
}

function allowanceLine(theme: Theme, snapshot: Snapshot): string | undefined {
	const included = snapshot.balance.included;
	if (
		!included ||
		typeof included.balance_usd !== "number" ||
		typeof included.allowance_usd !== "number" ||
		included.allowance_usd <= 0
	) {
		return undefined;
	}
	const balance = `${money(included.balance_usd)} of ${money(included.allowance_usd)} left`;
	const renew = included.period?.until
		? ` · renews ${included.period.until.slice(0, 10)} (${fmtCountdown(included.period.until)})`
		: "";
	return theme.fg("dim", `${balance}${renew}`);
}

/** Multi-line report for /ollama-usage. Always shows the full detail. */
export function reportLines(
	theme: Theme,
	snapshot: Snapshot,
	options: VisualOptions,
	stats?: UsageStats,
): string[] {
	const glyph = iconGlyph(options.icon);
	const lines = [theme.fg("accent", `${glyph ? `${glyph} ` : ""}monitor usage`)];

	for (const segment of limitSegments(snapshot.balance)) {
		const reset = segment.resetsAt ? theme.fg("dim", `  (resets ${fmtCountdown(segment.resetsAt)})`) : "";
		lines.push(
			`  ${theme.fg("muted", segment.short.padEnd(5))} ${bar(theme, segment.used)} ` +
				`${theme.fg(colorFor(segment.used), `${segment.used}% used`)}${reset}`,
		);
	}

	const allowance = allowanceLine(theme, snapshot);
	if (allowance) lines.push(`  ${allowance}`);

	const purchased = snapshot.balance.purchased?.balance_usd;
	if (typeof purchased === "number" && purchased > 0) {
		lines.push(`  ${theme.fg("dim", `Purchased credits: $${purchased.toFixed(2)}`)}`);
	}

	if (stats) {
		const totals = stats.totals;
		const summary = [`${fmtInt(totals.request_count)} requests`];
		if (typeof totals.usage_usd === "number") summary.push(`$${totals.usage_usd.toFixed(2)}`);
		if (typeof totals.input_tokens === "number") summary.push(`${fmtTokens(totals.input_tokens)} in`);
		if (typeof totals.cached_input_tokens === "number") summary.push(`${fmtTokens(totals.cached_input_tokens)} cached`);
		if (typeof totals.output_tokens === "number") summary.push(`${fmtTokens(totals.output_tokens)} out`);
		lines.push(`  ${theme.fg("muted", stats.range ?? "24h")}  ${theme.fg("dim", summary.join(" · "))}`);
	}

	const rate = usageRatePerHour(snapshot);
	const rateMin = usageRatePerMinute(snapshot);
	if (rate !== undefined || rateMin !== undefined) {
		const used = Math.max(...limitSegments(snapshot.balance).map((segment) => segment.used));
		const remainingHours = rate !== undefined && rate > 0 ? Math.max(0, (100 - used) / rate) : Infinity;
		const projection = Number.isFinite(remainingHours) ? ` · runs out in ~${formatDuration(remainingHours)}` : "";
		const rates: string[] = [];
		if (rate !== undefined) rates.push(`${formatRate(rate)} (${RATE_WINDOW_HOURS}h avg)`);
		if (rateMin !== undefined) rates.push(`${formatRatePerMinute(rateMin)} (${RATE_MIN_WINDOW_MINUTES}m avg)`);
		lines.push(`  ${theme.fg("muted", "rate")}   ${theme.fg("dim", `${rates.join(" · ")}${projection}`)}`);
	}

	lines.push(theme.fg("dim", `  updated ${fmtClock(snapshot.fetchedAt)} (${fmtAge(snapshot.fetchedAt)} ago)`));
	return lines;
}
