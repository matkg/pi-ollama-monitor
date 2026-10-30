/**
 * Ollama Cloud API access and quota math.
 *
 * Everything in this module is free of Pi runtime imports (except a type-only
 * import), so it can be tested with plain `node --test`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const API_BASE = "https://ollama.com";
const FETCH_TIMEOUT_MS = 10_000;

/** Hours of usage history used for the %/hour burn rate. */
export const RATE_WINDOW_HOURS = 3;
/** Minutes of usage history used for the %/minute burn rate. */
export const RATE_MIN_WINDOW_MINUTES = 60;
/** Ignore stats older than this when computing burn rates. */
export const RATE_MAX_STATS_AGE_MS = 15 * 60_000;

// --- API types (subset of the fields we render) ---

export interface BalanceWindow {
	remaining_percent: number;
	resets_at?: string;
}

export interface Balance {
	included?: {
		session?: BalanceWindow;
		weekly?: BalanceWindow;
		monthly?: BalanceWindow;
		balance_usd?: number;
		allowance_usd?: number;
		period?: { from?: string; until?: string };
	};
	purchased?: { balance_usd?: number };
}

export interface UsageBucket {
	from?: string;
	until?: string;
	partial?: boolean;
	request_count: number;
	usage_usd?: number;
	input_tokens?: number;
	cached_input_tokens?: number;
	output_tokens?: number;
}

export interface UsageTotals {
	request_count: number;
	usage_usd?: number;
	input_tokens?: number;
	cached_input_tokens?: number;
	output_tokens?: number;
}

export interface UsageStats {
	range?: string;
	totals: UsageTotals;
	buckets?: UsageBucket[];
}

export interface Snapshot {
	balance: Balance;
	stats?: UsageStats;
	statsFetchedAt?: number;
	fetchedAt: number;
}

export interface Segment {
	/** Short window label: "5h", "7d", "30d" or "plan". */
	short: string;
	/** Percentage of the quota already used, 0-100. */
	used: number;
	resetsAt?: string;
}

export type UsageRange = "24h" | "7d" | "30d";

// --- Helpers ---

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function clampPercent(value: number): number {
	return Math.min(Math.max(Math.round(value), 0), 100);
}

export function parseRange(arg: string): UsageRange | undefined {
	const value = arg.trim().toLowerCase();
	if (value === "" || value === "24h") return "24h";
	if (value === "7d" || value === "30d") return value;
	return undefined;
}

function httpMessage(status: number): string {
	if (status === 401 || status === 403) return "authentication failed — check your Ollama Cloud API key";
	if (status === 404) return "endpoint unavailable (404)";
	if (status === 429) return "rate limited — try again shortly";
	if (status >= 500) return `server error (${status})`;
	return `unexpected response (${status})`;
}

// --- API access ---

/**
 * Resolve the Ollama Cloud key through Pi's provider auth chain, falling back
 * to OLLAMA_API_KEY for the case where the provider is not registered yet.
 */
export async function getApiKey(ctx: Pick<ExtensionContext, "modelRegistry">): Promise<string | undefined> {
	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider("ollama-cloud");
		if (key) return key;
	} catch {
		// Provider may not be registered yet (or auth lookup failed); fall through to env.
	}
	return process.env.OLLAMA_API_KEY || undefined;
}

async function getJson<T>(path: string, key: string): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, {
		headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(httpMessage(res.status));
	const data: unknown = await res.json();
	if (!isRecord(data)) throw new Error("unexpected response shape");
	return data as T;
}

export async function getBalance(key: string): Promise<Balance> {
	const data = await getJson<Balance>("/api/balance", key);
	if (data.included === undefined && data.purchased === undefined) {
		throw new Error("unexpected response shape from /api/balance");
	}
	return data;
}

export async function getStats(key: string, range: UsageRange): Promise<UsageStats> {
	const data = await getJson<UsageStats>(`/api/usage?range=${range}`, key);
	if (!isRecord(data.totals) || typeof data.totals.request_count !== "number") {
		throw new Error("unexpected response shape from /api/usage");
	}
	return data;
}

// --- Quota math ---

/**
 * Normalize the API into display segments. Accounts with rolling windows
 * report one segment per window; accounts with a monthly dollar allowance
 * report a single "plan" segment.
 */
export function limitSegments(balance: Balance): Segment[] {
	const included = balance.included;
	if (!included) return [];

	const segments: Segment[] = [];
	for (const [key, short] of [
		["session", "5h"],
		["weekly", "7d"],
		["monthly", "30d"],
	] as const) {
		const window = included[key];
		if (window && typeof window.remaining_percent === "number" && Number.isFinite(window.remaining_percent)) {
			segments.push({
				short,
				used: clampPercent(100 - window.remaining_percent),
				resetsAt: window.resets_at,
			});
		}
	}

	if (
		segments.length === 0 &&
		typeof included.balance_usd === "number" &&
		typeof included.allowance_usd === "number" &&
		included.allowance_usd > 0
	) {
		segments.push({ short: "plan", used: clampPercent((1 - included.balance_usd / included.allowance_usd) * 100) });
	}

	return segments;
}

/** Earliest upcoming quota reset across the reported windows and the plan period. */
export function nextResetIso(snapshot: Snapshot, now = Date.now()): string | undefined {
	const candidates: number[] = [];

	for (const segment of limitSegments(snapshot.balance)) {
		if (!segment.resetsAt) continue;
		const at = Date.parse(segment.resetsAt);
		if (Number.isFinite(at) && at > now) candidates.push(at);
	}

	const until = snapshot.balance.included?.period?.until;
	if (until) {
		const at = Date.parse(until);
		if (Number.isFinite(at) && at > now) candidates.push(at);
	}

	return candidates.length > 0 ? new Date(Math.min(...candidates)).toISOString() : undefined;
}

/**
 * Allowance consumption inside a trailing window of the hourly /api/usage
 * buckets, in percentage points of the plan allowance. Partial buckets are
 * weighted by the fraction of the bucket that falls inside the window.
 */
export function allowancePercentInWindow(
	snapshot: Snapshot,
	windowMs: number,
	now = Date.now(),
): { percent: number; coveredMs: number } | undefined {
	const stats = snapshot.stats;
	const allowance = snapshot.balance.included?.allowance_usd;
	if (!stats?.buckets?.length || typeof allowance !== "number" || allowance <= 0) return undefined;
	if (snapshot.statsFetchedAt === undefined || now - snapshot.statsFetchedAt > RATE_MAX_STATS_AGE_MS) {
		return undefined;
	}

	const windowStart = now - windowMs;
	let spend = 0;
	let coveredMs = 0;

	for (const bucket of stats.buckets) {
		if (typeof bucket.usage_usd !== "number" || !bucket.from) continue;
		const from = Date.parse(bucket.from);
		const until = bucket.until ? Date.parse(bucket.until) : now;
		if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) continue;

		const overlap = Math.min(until, now) - Math.max(from, windowStart);
		if (overlap <= 0) continue;

		spend += bucket.usage_usd * (overlap / (until - from));
		coveredMs += overlap;
	}

	if (coveredMs < 60_000) return undefined;
	return { percent: (spend / allowance) * 100, coveredMs };
}

/** Average burn rate in percentage points per hour over the last 3 hours. */
export function usageRatePerHour(snapshot: Snapshot, now = Date.now()): number | undefined {
	const window = allowancePercentInWindow(snapshot, RATE_WINDOW_HOURS * 3_600_000, now);
	if (!window) return undefined;
	return window.percent / (window.coveredMs / 3_600_000);
}

/** Average burn rate in percentage points per minute over the last 60 minutes. */
export function usageRatePerMinute(snapshot: Snapshot, now = Date.now()): number | undefined {
	const window = allowancePercentInWindow(snapshot, RATE_MIN_WINDOW_MINUTES * 60_000, now);
	if (!window) return undefined;
	return window.percent / (window.coveredMs / 60_000);
}
