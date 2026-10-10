import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcClient, type RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

describe("RpcClient.start", () => {
	test.each(["write-rejection", "flush-throw", "kill-throw"])(
		"retires a failed transport and restarts through its spawn interface: %s",
		async failure => {
			let starts = 0;
			let kills = 0;
			using client = new RpcClient({
				spawn: (): RpcAgentProcess => {
					const failed = starts++ === 0;
					const exit = Promise.withResolvers<number>();
					let output: ReadableStreamDefaultController<Uint8Array> | undefined;
					const stdin = {
						write(data: string | Uint8Array) {
							if (failed)
								return failure === "flush-throw" ? 0 : Promise.reject(new Error("EPIPE fixture write"));
							const frame = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
							if (!isRecord(frame)) throw new Error("Expected request frame");
							output?.enqueue(
								new TextEncoder().encode(
									`${JSON.stringify({ type: "response", id: frame.id, command: frame.type, success: true, data: {} })}\n`,
								),
							);
							return 1;
						},
						flush() {
							if (failed && failure === "flush-throw") throw new Error("EPIPE fixture flush");
							return 0;
						},
					};
					return {
						stdin,
						stdout: new ReadableStream<Uint8Array>({
							start(controller) {
								output = controller;
								controller.enqueue(new TextEncoder().encode('{"type":"ready"}\n'));
							},
						}),
						peekStderr: () => "",
						kill() {
							kills++;
							output?.close();
							exit.resolve(0);
							if (failed && failure === "kill-throw") throw new Error("Already exited");
						},
						exited: exit.promise,
					};
				},
			});
			await client.start();
			await expect(client.getState()).rejects.toThrow("EPIPE fixture");
			await expect(client.getState()).rejects.toThrow("Client not started");
			expect(kills).toBe(1);
			await client.start();
			await expect(client.getState()).resolves.toBeDefined();
			expect(starts).toBe(2);
			await client.stop();
		},
	);
	test("rejects when RPC process exits immediately", async () => {
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, ".."),
			provider: "__missing_provider__",
			model: "claude-sonnet-4-5",
			env: { PI_NO_TITLE: "1" },
		});

		await expect(client.start()).rejects.toThrow(/Unknown provider.*__missing_provider__/);
	});
	test("launcher builder receives the complete agent argv", async () => {
		let received: string[] | undefined;
		using client = new RpcClient({
			command: args => {
				received = args;
				return [process.execPath, "--eval", "process.exit(1)"];
			},
			provider: "openrouter",
			model: "example/model",
			args: ["--no-session"],
		});

		await expect(client.start()).rejects.toThrow(/exited with code 1/);
		expect(received).toEqual([
			"--mode",
			"rpc",
			"--provider",
			"openrouter",
			"--model",
			"example/model",
			"--no-session",
		]);
	});
});
