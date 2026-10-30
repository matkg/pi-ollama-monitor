/**
 * Persisted visual options for the Ollama quota extension.
 *
 * Global options live in <agent-dir>/ollama-usage.json; a project override in
 * <cwd>/.pi/ollama-usage.json takes precedence. Environment variables override
 * both at load time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Placement = "path" | "status";
export type IconName = "llama" | "cloud" | "none";

export interface VisualOptions {
	footer: boolean;
	placement: Placement;
	icon: IconName;
	bar: boolean;
	percent: boolean;
	rate: boolean;
	rateMin: boolean;
	reset: boolean;
	dollars: boolean;
	updated: boolean;
	widget: boolean;
}

export const DEFAULT_OPTIONS: VisualOptions = {
	footer: true,
	placement: "path",
	icon: "llama",
	bar: true,
	percent: true,
	rate: true,
	rateMin: true,
	reset: true,
	dollars: false,
	updated: false,
	widget: false,
};

export const BOOLEAN_OPTIONS = [
	"footer",
	"bar",
	"percent",
	"rate",
	"rateMin",
	"reset",
	"dollars",
	"updated",
	"widget",
] as const;

export type BooleanOption = (typeof BOOLEAN_OPTIONS)[number];
export type ConfigName = BooleanOption | "placement" | "icon";

export const CONFIG_OPTIONS: ReadonlyArray<{ name: ConfigName; description: string }> = [
	{ name: "footer", description: "usage line in the footer" },
	{ name: "placement", description: "path (top-right on the path line) or status (line below)" },
	{ name: "icon", description: "llama (🦙), cloud (☁), or none" },
	{ name: "bar", description: "ASCII progress bar" },
	{ name: "percent", description: "used percentage" },
	{ name: "rate", description: "burn rate over the last 3 hours (%/hour)" },
	{ name: "rateMin", description: "burn rate over the last 60 minutes (%/min)" },
	{ name: "reset", description: "quota reset date and time" },
	{ name: "dollars", description: "remaining allowance ($balance/$allowance)" },
	{ name: "updated", description: "time of the last successful refresh" },
	{ name: "widget", description: "detailed usage line above the editor" },
];

export const OPTIONS_FILE = "ollama-usage.json";

export interface OptionsContext {
	/** Pi agent config directory (usually ~/.pi/agent). */
	agentDir: string;
	/** Session working directory, for the project override. */
	cwd: string;
}

function envFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
	const raw = env[name];
	if (raw === undefined) return fallback;
	const value = raw.trim().toLowerCase();
	if (value === "" || value === "0" || value === "false" || value === "no" || value === "off") return false;
	return true;
}

export function isPlacement(value: unknown): value is Placement {
	return value === "path" || value === "status";
}

export function isIcon(value: unknown): value is IconName {
	return value === "llama" || value === "cloud" || value === "none";
}

export function parseToggle(arg: string, current: boolean): boolean | undefined {
	const value = arg.trim().toLowerCase();
	if (value === "") return !current;
	if (["on", "enable", "true", "1"].includes(value)) return true;
	if (["off", "disable", "false", "0"].includes(value)) return false;
	return undefined;
}

export function parsePlacement(value: string | undefined): Placement | undefined {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "path" || normalized === "top") return "path";
	if (normalized === "status" || normalized === "line" || normalized === "below") return "status";
	return undefined;
}

export function parseIcon(value: string | undefined): IconName | undefined {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "llama" || normalized === "🦙") return "llama";
	if (normalized === "cloud" || normalized === "☁" || normalized === "☁️") return "cloud";
	if (normalized === "none" || normalized === "off") return "none";
	return undefined;
}

/** Path of the global (project=false) or project-local options file. */
export function optionsFile(ctx: OptionsContext, project: boolean): string {
	return project ? join(ctx.cwd, ".pi", OPTIONS_FILE) : join(ctx.agentDir, OPTIONS_FILE);
}

export function readOptionsFile(path: string): Partial<VisualOptions> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const record = parsed as Record<string, unknown>;
		const out: Partial<VisualOptions> = {};
		for (const key of BOOLEAN_OPTIONS) {
			if (typeof record[key] === "boolean") out[key] = record[key] as boolean;
		}
		if (isPlacement(record.placement)) out.placement = record.placement;
		if (isIcon(record.icon)) out.icon = record.icon;
		return out;
	} catch {
		return {};
	}
}

export function loadVisualOptions(ctx: OptionsContext, env: NodeJS.ProcessEnv = process.env): VisualOptions {
	const merged: VisualOptions = {
		...DEFAULT_OPTIONS,
		...readOptionsFile(optionsFile(ctx, false)),
		...readOptionsFile(optionsFile(ctx, true)),
	};
	// Environment overrides win over stored choices.
	if (!envFlag(env, "PI_OLLAMA_USAGE_STATUS", true)) merged.footer = false;
	if (envFlag(env, "PI_OLLAMA_USAGE_WIDGET", false)) merged.widget = true;
	return merged;
}

/**
 * Persist a single option. Writes the project file when the project already
 * has one, otherwise the global file, preserving unrelated keys.
 */
export function saveOptionKey(
	ctx: OptionsContext,
	key: ConfigName,
	value: boolean | Placement | IconName,
): { path: string; error?: string } {
	const projectPath = optionsFile(ctx, true);
	const target = existsSync(projectPath) ? projectPath : optionsFile(ctx, false);
	try {
		let current: Record<string, unknown> = {};
		if (existsSync(target)) {
			const parsed: unknown = JSON.parse(readFileSync(target, "utf-8"));
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				current = parsed as Record<string, unknown>;
			}
		}
		current[key] = value;
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
		return { path: target };
	} catch (err) {
		return { path: target, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Case-insensitive lookup of a boolean option name (e.g. "ratemin" -> "rateMin"). */
export function findBooleanOption(name: string): BooleanOption | undefined {
	const normalized = name.trim().toLowerCase();
	return BOOLEAN_OPTIONS.find((option) => option.toLowerCase() === normalized);
}

export function configSummary(options: VisualOptions): string {
	const lines = ["Ollama quota visuals:"];
	for (const { name, description } of CONFIG_OPTIONS) {
		const value =
			name === "placement" ? options.placement : name === "icon" ? options.icon : options[name] ? "on" : "off";
		lines.push(`  ${name.padEnd(10)} ${value.padEnd(6)} ${description}`);
	}
	lines.push("  toggle: /ollama-usage-config <option> [on|off]");
	return lines.join("\n");
}
