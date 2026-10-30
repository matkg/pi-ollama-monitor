import assert from "node:assert/strict";
import test from "node:test";
import type { Snapshot, UsageBucket } from "../api.ts";
import { DEFAULT_OPTIONS, type VisualOptions } from "../options.ts";
import {
	composeParts,
	reportLines,
	statusText,
	widgetLines,
} from "../render.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
};

function options(overrides: Partial<VisualOptions> = {}): VisualOptions {
	return { ...DEFAULT_OPTIONS, ...overrides };
}

function snapshot(buckets: UsageBucket[] = []): Snapshot {
	const now = Date.now();
	return {
		balance: {
			included: {
				allowance_usd: 60,
				balance_usd: 36,
				period: { until: new Date(now + 8 * 24 * 3_600_000).toISOString() },
			},
		},
		stats: buckets.length > 0 ? { range: "24h", totals: { request_count: 3 }, buckets } : undefined,
		statsFetchedAt: buckets.length > 0 ? now : undefined,
		fetchedAt: now,
	};
}

function recentBuckets(): UsageBucket[] {
	const now = Date.now();
	const iso = (ms: number) => new Date(ms).toISOString();
	return [
		{ from: iso(now - 60 * 60_000), until: iso(now - 30 * 60_000), request_count: 1, usage_usd: 0.5 },
		{ from: iso(now - 30 * 60_000), until: iso(now), request_count: 1, usage_usd: 0.5, partial: true },
	];
}

test("composeParts carries the plan segment and flags", () => {
	const parts = composeParts(snapshot(), options());
	assert.ok(parts);
	assert.deepEqual(parts.segments.map((s) => [s.short, s.used]), [["plan", 40]]);
	assert.equal(parts.bar, true);
	assert.equal(parts.percent, true);
	assert.equal(parts.dollars, undefined, "dollars off by default");
	assert.ok(parts.reset, "reset follows the period");
	assert.equal(parts.updated, undefined);
	assert.deepEqual(parts.rates, []);
});

test("composeParts honours dollars, updated and both rates", () => {
	const parts = composeParts(snapshot(recentBuckets()), options({ dollars: true, updated: true }));
	assert.ok(parts);
	assert.equal(parts.dollars, "$36/$60");
	assert.match(parts.updated ?? "", /^\d{1,2}:\d{2}$/);
	assert.equal(parts.rates.length, 2);
	assert.match(parts.rates[0], /%\/h$/);
	assert.match(parts.rates[1], /%\/min$/);
});

test("statusText renders label, bar, percent, reset and rates", () => {
	const line = statusText(theme, snapshot(recentBuckets()), options());
	assert.ok(line);
	assert.match(line, /🦙 monitor/);
	assert.match(line, /[█░]{10}/);
	assert.match(line, /40%/);
	assert.match(line, /resets /);
	assert.match(line, /%\/h · .*%\/min/);
});

test("statusText respects icon and compact options", () => {
	assert.match(statusText(theme, snapshot(), options({ icon: "cloud" })) ?? "", /☁ monitor/);
	assert.doesNotMatch(statusText(theme, snapshot(), options({ icon: "none" })) ?? "", /🦙|☁/);

	const compact = statusText(theme, snapshot(recentBuckets()), options(), true);
	assert.ok(compact);
	assert.doesNotMatch(compact, /resets|%\/h|%\/min/);
	assert.match(compact, /monitor .*40%/);
});

test("statusText is hidden when every content option is off", () => {
	const line = statusText(
		theme,
		snapshot(),
		options({ bar: false, percent: false, rate: false, rateMin: false, reset: false, dollars: false }),
	);
	assert.equal(line, undefined);
});

test("widgetLines includes dollars, reset and rates but only enabled parts", () => {
	const full = widgetLines(theme, snapshot(recentBuckets()), options({ dollars: true }))[0];
	assert.ok(full);
	assert.match(full, /Ollama Cloud|monitor/);
	assert.match(full, /\$36\/\$60 left/);
	assert.match(full, /resets /);
	assert.match(full, /%\/h/);
	assert.match(full, /%\/min/);

	const minimal = widgetLines(theme, snapshot(), options({ dollars: false, reset: false, rate: false, rateMin: false }))[0];
	assert.ok(minimal);
	assert.doesNotMatch(minimal, /\$|resets|%\/h|%\/min/);
	assert.deepEqual(
		widgetLines(
			theme,
			snapshot(),
			options({ bar: false, percent: false, dollars: false, reset: false, rate: false, rateMin: false }),
		),
		[],
	);
});

test("reportLines includes allowance, reset countdown and both rate averages", () => {
	const snap = snapshot(recentBuckets());
	const lines = reportLines(theme, snap, options(), snap.stats).join("\n");
	assert.match(lines, /\$36 of \$60 left/);
	assert.match(lines, /renews /);
	assert.match(lines, /rate\s+.*%\/h \(3h avg\)/);
	assert.match(lines, /%\/min \(60m avg\)/);
	assert.match(lines, /updated \d{1,2}:\d{2}/);
	assert.match(lines, /3 requests/);
});
