import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IdaWorker } from "@oh-my-pi/pi-coding-agent/ida/supervisor";
import { acquireFileLock, TempDir } from "@oh-my-pi/pi-utils";

it.skipIf(process.platform === "win32")(
	"retires an IDA worker whose stdin closes without process exit and releases its database lease",
	async () => {
		using directory = TempDir.createSync("@pi-ida-transport-");
		const executable = directory.join("fixture-worker");
		await fs.copyFile(path.join(import.meta.dir, "../fixtures/ida-closed-stdin-worker.ts"), executable);
		await fs.chmod(executable, 0o755);
		const database = directory.join("fixture.i64");
		await Bun.write(database, "fixture");
		const lease = await acquireFileLock(database);
		const worker = await IdaWorker.start(
			{
				id: "fixture",
				dir: directory.path(),
				sourcePath: database,
				kind: "inplace",
				openPath: database,
				isNew: false,
				lockTarget: database,
			},
			{ pythonPath: executable, env: { PATH: process.env.PATH ?? "" } },
			lease,
			0,
		);
		try {
			await expect(worker.request("view", { query: "fixture" })).rejects.toThrow("Failed to send view");
			await worker.exited;
			const reacquired = await acquireFileLock(database, { retries: 1 });
			reacquired.release();
			await expect(worker.request("view", {})).rejects.toThrow();
			expect(await Bun.file(database).text()).toBe("fixture");
		} finally {
			await worker.close({ save: false }).catch(() => {});
			lease.release();
		}
	},
	5000,
);
