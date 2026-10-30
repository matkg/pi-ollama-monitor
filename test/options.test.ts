import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BOOLEAN_OPTIONS,
	DEFAULT_OPTIONS,
	configSummary,
	findBooleanOption,
	loadVisualOptions,
	optionsFile,
	parseIcon,
	parsePlacement,
	parseToggle,
	saveOptionKey,
} from "../options.ts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-ollama-quota-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, agentDir, cwd };
}

function writeJson(path: string, value: unknown) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

test("defaults apply when no options files exist", () => {
	const { agentDir, cwd } = setup();
	assert.deepEqual(loadVisualOptions({ agentDir, cwd }, {}), DEFAULT_OPTIONS);
});

test("project options override global options", () => {
	const { agentDir, cwd } = setup();
	writeJson(join(agentDir, "ollama-usage.json"), { bar: false, dollars: true, icon: "cloud" });
	writeJson(join(cwd, ".pi", "ollama-usage.json"), { percent: false, icon: "none" });

	const options = loadVisualOptions({ agentDir, cwd }, {});
	assert.equal(options.bar, false, "global value kept");
	assert.equal(options.dollars, true, "global value kept");
	assert.equal(options.percent, false, "project overrides");
	assert.equal(options.icon, "none", "project overrides");
});

test("environment overrides win over stored options", () => {
	const { agentDir, cwd } = setup();
	writeJson(join(agentDir, "ollama-usage.json"), { footer: true, widget: false });

	const options = loadVisualOptions({ agentDir, cwd }, {
		PI_OLLAMA_USAGE_STATUS: "0",
		PI_OLLAMA_USAGE_WIDGET: "1",
	});
	assert.equal(options.footer, false);
	assert.equal(options.widget, true);
});

test("invalid stored values are ignored", () => {
	const { agentDir, cwd } = setup();
	writeJson(join(agentDir, "ollama-usage.json"), {
		bar: "yes",
		placement: "sidebar",
		icon: "penguin",
		rateMin: 0,
	});

	const options = loadVisualOptions({ agentDir, cwd }, {});
	assert.equal(options.bar, DEFAULT_OPTIONS.bar);
	assert.equal(options.placement, DEFAULT_OPTIONS.placement);
	assert.equal(options.icon, DEFAULT_OPTIONS.icon);
	assert.equal(options.rateMin, DEFAULT_OPTIONS.rateMin);
});

test("saveOptionKey writes only the changed key to the global file", () => {
	const { agentDir, cwd } = setup();
	const globalPath = optionsFile({ agentDir, cwd }, false);
	writeJson(globalPath, { bar: false });

	const result = saveOptionKey({ agentDir, cwd }, "dollars", true);
	assert.equal(result.path, globalPath);
	assert.equal(result.error, undefined);
	assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf-8")), { bar: false, dollars: true });
});

test("saveOptionKey targets the project file when one exists", () => {
	const { agentDir, cwd } = setup();
	const globalPath = optionsFile({ agentDir, cwd }, false);
	const projectPath = optionsFile({ agentDir, cwd }, true);
	writeJson(globalPath, { bar: false });
	writeJson(projectPath, { percent: true });

	const result = saveOptionKey({ agentDir, cwd }, "bar", true);
	assert.equal(result.path, projectPath);
	assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf-8")), { percent: true, bar: true });
	assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf-8")), { bar: false }, "global untouched");
});

test("saveOptionKey creates the agent directory on demand", () => {
	const { root, cwd } = setup();
	const agentDir = join(root, "nested", "agent");
	const result = saveOptionKey({ agentDir, cwd }, "icon", "cloud");
	assert.equal(result.error, undefined);
	assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "ollama-usage.json"), "utf-8")), { icon: "cloud" });
});

test("argument parsers accept the documented aliases", () => {
	assert.equal(parseToggle("", false), true);
	assert.equal(parseToggle("", true), false);
	assert.equal(parseToggle("ON", false), true);
	assert.equal(parseToggle("disable", true), false);
	assert.equal(parseToggle("0", true), false);
	assert.equal(parseToggle("maybe", true), undefined);

	assert.equal(parsePlacement("top"), "path");
	assert.equal(parsePlacement("below"), "status");
	assert.equal(parsePlacement("sidebar"), undefined);

	assert.equal(parseIcon("🦙"), "llama");
	assert.equal(parseIcon("☁️"), "cloud");
	assert.equal(parseIcon("off"), "none");
	assert.equal(parseIcon("penguin"), undefined);
});

test("option names match case-insensitively", () => {
	assert.equal(findBooleanOption("ratemin"), "rateMin");
	assert.equal(findBooleanOption("RATEMIN"), "rateMin");
	assert.equal(findBooleanOption(" rateMin "), "rateMin");
	assert.equal(findBooleanOption("footer"), "footer");
	assert.equal(findBooleanOption("nope"), undefined);
});

test("configSummary lists every option", () => {
	const summary = configSummary(DEFAULT_OPTIONS);
	for (const key of BOOLEAN_OPTIONS) assert.match(summary, new RegExp(`\\b${key}\\b`));
	assert.match(summary, /placement/);
	assert.match(summary, /icon/);
	assert.match(summary, /llama/);
});
