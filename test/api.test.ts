import assert from "node:assert/strict";
import test from "node:test";
import {
	limitSegments,
	nextResetIso,
	usageRatePerHour,
	usageRatePerMinute,
	type Snapshot,
	type UsageBucket,
} from "../api.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const HOUR = 3_600_000;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function snapshot(
	buckets: UsageBucket[],
	options: { allowance?: number; balance?: number; statsFetchedAt?: number } = {},
): Snapshot {
	return {
		balance: {
			included: {
				allowance_usd: options.allowance ?? 60,
				balance_usd: options.balance ?? 36,
			},
		},
		stats: { range: "24h", totals: { request_count: 0 }, buckets },
		statsFetchedAt: options.statsFetchedAt ?? NOW,
		fetchedAt: NOW,
	};
}

test("usageRatePerHour averages the trailing 3h window", () => {
	const snap = snapshot([
		{ from: iso(NOW - 3 * HOUR), until: iso(NOW - 2 * HOUR), request_count: 1, usage_usd: 2 },
		{ from: iso(NOW - 2 * HOUR), until: iso(NOW - 1 * HOUR), request_count: 1, usage_usd: 2 },
		{ from: iso(NOW - 1 * HOUR), until: iso(NOW), request_count: 1, usage_usd: 2, partial: true },
	]);
	// $6 of a $60 allowance = 10% over 3h => 3.33%/h
	const rate = usageRatePerHour(snap, NOW);
	assert.ok(rate !== undefined);
	assert.ok(Math.abs(rate - 3.3333) < 0.01, `got ${rate}`);
});

test("usageRatePerMinute weights partial buckets", () => {
	const halfHour = snapshot([
		{ from: iso(NOW - 30 * MIN), until: iso(NOW), request_count: 1, usage_usd: 1, partial: true },
	]);
	// $1 of $60 = 1.667% over 30m => 0.0556%/min
	const rate = usageRatePerMinute(halfHour, NOW);
	assert.ok(rate !== undefined);
	assert.ok(Math.abs(rate - 0.05556) < 0.001, `got ${rate}`);

	// $1 of $60 is 1.667% consumed in 30 minutes => 3.33%/h
	const perHour = usageRatePerHour(halfHour, NOW);
	assert.ok(perHour !== undefined);
	assert.ok(Math.abs(perHour - 3.3333) < 0.01, `got ${perHour}`);
});

test("burn rates are omitted for stale stats, missing allowance or empty buckets", () => {
	assert.equal(usageRatePerHour(snapshot([], { statsFetchedAt: NOW - 30 * MIN }), NOW), undefined);
	assert.equal(usageRatePerMinute(snapshot([], { statsFetchedAt: NOW - 30 * MIN }), NOW), undefined);

	const noAllowance = snapshot([
		{ from: iso(NOW - HOUR), until: iso(NOW), request_count: 1, usage_usd: 5 },
	]);
	noAllowance.balance = { included: {} };
	assert.equal(usageRatePerHour(noAllowance, NOW), undefined);

	assert.equal(usageRatePerHour(snapshot([]), NOW), undefined);
	assert.equal(usageRatePerMinute(snapshot([]), NOW), undefined);
});

test("limitSegments prefers rolling windows and falls back to the plan allowance", () => {
	const plan = limitSegments({ included: { allowance_usd: 60, balance_usd: 36 } });
	assert.deepEqual(plan, [{ short: "plan", used: 40 }]);

	const windows = limitSegments({
		included: {
			session: { remaining_percent: 88, resets_at: iso(NOW + 2 * HOUR) },
			weekly: { remaining_percent: 50 },
			monthly: { remaining_percent: 10 },
			allowance_usd: 60,
			balance_usd: 36,
		},
	});
	assert.deepEqual(
		windows.map((s) => [s.short, s.used]),
		[
			["5h", 12],
			["7d", 50],
			["30d", 90],
		],
	);
});

test("nextResetIso picks the earliest future reset", () => {
	const snap: Snapshot = {
		balance: {
			included: {
				session: { remaining_percent: 90, resets_at: iso(NOW + 2 * HOUR) },
				period: { until: iso(NOW + 8 * 24 * HOUR) },
			},
		},
		fetchedAt: NOW,
	};
	assert.equal(nextResetIso(snap, NOW), iso(NOW + 2 * HOUR));

	const pastOnly: Snapshot = {
		balance: { included: { session: { remaining_percent: 90, resets_at: iso(NOW - HOUR) } } },
		fetchedAt: NOW,
	};
	assert.equal(nextResetIso(pastOnly, NOW), undefined);
});
