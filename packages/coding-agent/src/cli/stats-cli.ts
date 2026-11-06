/**
 * Stats CLI command handlers.
 *
 * Handles `omp stats` subcommand for viewing AI usage statistics.
 */

import { formatKeyHint } from "@oh-my-pi/pi-tui/key-hint-format";
import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { postmortem } from "@oh-my-pi/pi-utils";
import type { ModelStats } from "@oh-my-pi/omp-stats/shared-types";
import { formatNumber, formatPercent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { openStandaloneJudge } from "../judgment/standalone";
import { openTernPage } from "../tools/browser/tern/user-page";
import { harnessLabel, PromptCacheRollup, promptTokenTotal } from "../session/prompt-cache-stats";
import { openPath } from "../utils/open";

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way.
 */
function createSyncProgressReporter(): {
	onProgress: (event: { current: number; total: number; sessionFile: string }) => void;
	finish: () => void;
} {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			// Throttle to ~30 fps and always force a render for the last file.
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const label = chalk.dim(shortenSessionFile(event.sessionFile));
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			const counter = chalk.cyan(`[${event.current}/${event.total}]`);
			const line = `${counter} ${pct}%  ${label}`;
			const columns = stream.columns ?? 120;
			const trimmed = truncateToWidth(line, columns - 1);
			stream.write(`\r${trimmed.padEnd(lastWidth)}`);
			lastWidth = trimmed.length;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}

function shortenSessionFile(p: string): string {
	const marker = "/sessions/";
	const idx = p.indexOf(marker);
	return idx >= 0 ? p.slice(idx + marker.length) : p;
}

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	host: string;
	json: boolean;
	summary: boolean;
}

// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	// Lazy import to avoid loading stats module when not needed
	const {
		closeDb,
		formatStatsDashboardUrl,
		getDashboardStats,
		getTotalMessageCount,
		printStatsSummary,
		refreshRollups,
		setStatsCloseHandler,
		startServer,
		syncAllSessions,
	} = await import("@oh-my-pi/omp-stats");

	// One-shot reports need fully ingested, fully rolled-up data before printing.
	if (cmd.json || cmd.summary) {
		const progress = createSyncProgressReporter();
		process.stderr.write("Syncing session files...\n");
		const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
		progress.finish();
		await refreshRollups();
		const total = await getTotalMessageCount();
		process.stderr.write(`Synced ${processed} new entries from ${files} files (${total} total)\n\n`);
		if (cmd.json) {
			console.log(JSON.stringify(await getDashboardStats(), null, 2));
		} else {
			await printStatsSummary();
			printHarnessCacheSummary((await getDashboardStats()).byModel);
		}
		return;
	}

	// The dashboard starts immediately and ingests sessions in the background,
	// streaming progress to the page. The judge (settings, auth, registry)
	// resolves on the first Frustration estimate/run and lives until exit.
	// In a Tern pane the page takes this block's place until the user closes
	// it (its Close, Esc, Ctrl+C, or Tern's Close block), which stops the
	// dashboard; elsewhere the system browser shows it.
	const cwd = process.cwd();
	const { hostname, port } = await startServer(cmd.port, cmd.host, {
		judge: async () => (await openStandaloneJudge(cwd, "stats_frustration")).judge,
	});
	const url = formatStatsDashboardUrl(hostname, port);
	console.log(chalk.green(`Dashboard available at: ${url}`));

	// Close is on before the page first loads, and off again for the system
	// browser, where closing would leave a dead tab.
	setStatsCloseHandler(() => void postmortem.quit(0));
	const page = await openTernPage(url, "over");
	if (page) {
		console.log("Showing it in place of this block: close it to stop\n");
	} else {
		setStatsCloseHandler(undefined);
		openPath(url);
		console.log(`Press ${formatKeyHint("ctrl+c")} to stop\n`);
	}

	// Ctrl+C and the other signals exit through omp's cleanup, which takes the
	// page away with the dashboard.
	postmortem.register("stats-dashboard", async () => {
		await page?.close();
		closeDb();
	});
	if (page) {
		await page.closed();
		await postmortem.quit(0);
	}
	// Keep the process alive
	await new Promise(() => {});
}

/** Prompt-cache hit rate per harness profile; the cross-package summary knows models, not profiles. */
function printHarnessCacheSummary(byModel: readonly ModelStats[]): void {
	const harness = new PromptCacheRollup();
	for (const m of byModel) {
		harness.add(harnessLabel(m.provider, m.model), {
			requests: m.totalRequests,
			input: m.totalInputTokens,
			cacheRead: m.totalCacheReadTokens,
			cacheWrite: m.totalCacheWriteTokens,
		});
	}
	const rows = harness.entries();
	if (rows.length === 0) return;
	console.log(chalk.bold("By Harness Profile:"));
	for (const [label, row] of rows) {
		console.log(
			`  ${label}: ${formatPercent(row.hitPct / 100)} cache hit, ${formatNumber(row.requests)} reqs, ${formatNumber(row.cacheRead)} of ${formatNumber(promptTokenTotal(row))} prompt tokens`,
		);
	}
	console.log("");
}
