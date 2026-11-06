import { afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetHarnessPromptCache } from "@oh-my-pi/pi-coding-agent/harness/capture";

export interface HarnessCacheDirs {
	root: string;
	cache: string;
}

export function withHarnessCacheDir(prefix: string): HarnessCacheDirs {
	const dirs: HarnessCacheDirs = { root: "", cache: "" };
	let previous: string | undefined;
	beforeEach(async () => {
		dirs.root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
		dirs.cache = path.join(dirs.root, "harness-cache");
		previous = process.env.OMP_HARNESS_CACHE_DIR;
		process.env.OMP_HARNESS_CACHE_DIR = dirs.cache;
		resetHarnessPromptCache();
	});
	afterEach(async () => {
		resetHarnessPromptCache();
		if (previous === undefined) delete process.env.OMP_HARNESS_CACHE_DIR;
		else process.env.OMP_HARNESS_CACHE_DIR = previous;
		await fs.rm(dirs.root, { recursive: true, force: true });
	});
	return dirs;
}
