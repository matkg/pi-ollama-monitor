/**
 * Footer integration.
 *
 * Pi's footer renders `[path, stats/model, ...extension statuses]`. To place the
 * usage line at the top right, this wraps the exported `FooterComponent` and
 * right-aligns the usage text onto the path line. The wrapper is defensive: if
 * Pi's footer internals change shape, the caller's fallback path takes over.
 */

import { FooterComponent, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type FooterData = ConstructorParameters<typeof FooterComponent>[1];
type FooterSession = ConstructorParameters<typeof FooterComponent>[0];

export interface FooterComponentOptions {
	/** Current extension context (kept live across session/model changes). */
	getContext: () => ExtensionContext;
	footerData: FooterData;
	theme: Theme;
	/** Pi's TUI, for requesting repaints after refreshes. */
	tui: { requestRender(): void };
	/** Usage line; `compact` asks for the shortest variant. */
	usage: (theme: Theme, compact: boolean) => string | undefined;
	/** Called with the TUI so the extension can request repaints after refreshes. */
	onTui: (tui: { requestRender(): void }) => void;
	onDispose: () => void;
}

/**
 * Adapter for the AgentSession surface FooterComponent reads. Getters keep it
 * live across model, thinking-level and session changes.
 */
function createFooterSession(getContext: () => ExtensionContext): FooterSession {
	const adapter = {
		get state() {
			const ctx = getContext();
			return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
		},
		get sessionManager() {
			return getContext().sessionManager;
		},
		get routedModel() {
			return undefined;
		},
		get modelRuntime() {
			return { isUsingSubscription: () => false };
		},
		getContextUsage: () => getContext().getContextUsage(),
	};
	return adapter as unknown as FooterSession;
}

export function createFooterComponent(options: FooterComponentOptions) {
	const { getContext, footerData, theme, tui, usage, onTui, onDispose } = options;
	const base = new FooterComponent(createFooterSession(getContext), footerData);
	onTui(tui);

	return {
		invalidate() {
			base.invalidate();
		},
		dispose() {
			base.dispose();
			onDispose();
		},
		render(width: number): string[] {
			try {
				const lines = base.render(width);
				let line = usage(theme, false);
				if (!line || lines.length === 0) return lines;

				// Narrow terminals: try the compact variant before truncating.
				if (visibleWidth(line) + 2 >= width) {
					line = usage(theme, true) ?? line;
				}

				const usageWidth = visibleWidth(line);
				const minPad = 2;
				if (usageWidth + minPad >= width) return [truncateToWidth(line, width)];

				const pathLine = lines[0];
				const pathWidth = visibleWidth(pathLine);
				if (pathWidth + minPad + usageWidth <= width) {
					// Fits as-is: right-align the usage text on the path line.
					lines[0] = pathLine + " ".repeat(width - pathWidth - usageWidth) + line;
				} else {
					// Narrow terminal: truncate the path, keep the usage readable.
					const available = width - usageWidth - minPad;
					const left = truncateToWidth(pathLine, available, theme.fg("dim", "..."));
					const pad = Math.max(1, width - visibleWidth(left) - usageWidth);
					lines[0] = left + " ".repeat(pad) + line;
				}
				return lines;
			} catch {
				// Never break the footer if Pi's internals change shape.
				return [truncateToWidth(theme.fg("dim", "monitor usage unavailable"), width)];
			}
		},
	};
}
