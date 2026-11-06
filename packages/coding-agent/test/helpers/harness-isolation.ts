import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A recorded harness capture replaces block 0 of every profiled system prompt,
// so a suite that builds sessions would read the developer's real captures.
// Point the cache at an empty temp dir for the whole test process; suites that
// serve fixtures still opt in at runtime via withHarnessCacheDir.
if (!process.env.OMP_HARNESS_CACHE_DIR) {
	process.env.OMP_HARNESS_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omp-harness-cache-isolated-"));
}
