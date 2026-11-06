#!/usr/bin/env bun
import { closeSync } from "node:fs";

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let input = "";
while (!input.includes("\n")) {
	const chunk = await reader.read();
	if (chunk.done) throw new Error("Expected open request");
	input += decoder.decode(chunk.value, { stream: true });
}
reader.releaseLock();
const request: object | null = JSON.parse(input.split("\n")[0]);
if (
	!request ||
	typeof request !== "object" ||
	!("method" in request) ||
	request.method !== "open" ||
	!("id" in request) ||
	typeof request.id !== "number" ||
	!("params" in request) ||
	!request.params ||
	typeof request.params !== "object" ||
	!("path" in request.params) ||
	typeof request.params.path !== "string"
) {
	throw new Error("Expected open request");
}
closeSync(0);
console.log(
	JSON.stringify({
		id: request.id,
		ok: true,
		result: { idb: request.params.path, module: "fixture", format: "fixture", arch: "fixture", bitness: 64 },
	}),
);
setInterval(() => {}, 1000);
