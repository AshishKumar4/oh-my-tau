import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { JsDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";

let runtime: JsRuntime;

function collect(): {
	hooks: RuntimeHooks;
	displays: JsDisplayOutput[];
	texts: string[];
} {
	const displays: JsDisplayOutput[] = [];
	const texts: string[] = [];
	const hooks: RuntimeHooks = {
		onText: (chunk: string) => {
			texts.push(chunk);
		},
		onDisplay: (output: JsDisplayOutput) => {
			displays.push(output);
		},
		callTool: async () => undefined,
	};
	return { hooks, displays, texts };
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");

describe("JsRuntime.displayValue image coercion", () => {
	beforeAll(() => {
		runtime = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "display-image-coerce-test",
		});
	});

	afterAll(() => {
		runtime.dispose();
	});

	it("passes through strict base64 strings verbatim", () => {
		const { hooks, displays } = collect();
		runtime.displayValue({ type: "image", data: PNG_BASE64, mimeType: "image/png" }, hooks);
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("base64-encodes Uint8Array data", () => {
		const { hooks, displays } = collect();
		runtime.displayValue({ type: "image", data: PNG_BYTES, mimeType: "image/png" }, hooks);
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("base64-encodes Buffer data", () => {
		const { hooks, displays } = collect();
		runtime.displayValue({ type: "image", data: Buffer.from(PNG_BYTES), mimeType: "image/png" }, hooks);
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("base64-encodes ArrayBuffer data", () => {
		const { hooks, displays } = collect();
		const ab = PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength);
		runtime.displayValue({ type: "image", data: ab, mimeType: "image/png" }, hooks);
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("recovers decimal CSV produced by Uint8Array.prototype.toString", () => {
		// Reproduces the puppeteer footgun: page.screenshot() returns Uint8Array, and
		// `uint8array.toString("base64")` silently falls through to Array.toString,
		// yielding "137,80,78,71,...". Anthropic rejects that as invalid base64.
		const { hooks, displays } = collect();
		const decimalCsv = Array.from(PNG_BYTES).toString();
		expect(decimalCsv).toBe("137,80,78,71,13,10,26,10");
		runtime.displayValue({ type: "image", data: decimalCsv, mimeType: "image/png" }, hooks);
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("recovers JSON-serialized Buffer shape ({ type: 'Buffer', data: [...] })", () => {
		const { hooks, displays } = collect();
		const jsonBuffer = JSON.parse(JSON.stringify(Buffer.from(PNG_BYTES))) as {
			type: string;
			data: number[];
		};
		runtime.displayValue({ type: "image", data: jsonBuffer, mimeType: "image/png" }, hooks);
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("drops images whose data is unrecognized and surfaces a diagnostic in text", () => {
		const { hooks, displays, texts } = collect();
		runtime.displayValue({ type: "image", data: { not: "a buffer" }, mimeType: "image/png" }, hooks);
		expect(displays).toHaveLength(0);
		expect(texts.join("")).toMatch(/image dropped/);
	});

	it("rejects strings that look base64-ish but aren't strictly valid", () => {
		// Padding mid-string, whitespace, or URL-safe alphabet are all dropped — the
		// Anthropic API only honors strict base64 in image sources.
		const { hooks, displays, texts } = collect();
		runtime.displayValue({ type: "image", data: "abcd=efg", mimeType: "image/png" }, hooks);
		expect(displays).toHaveLength(0);
		expect(texts.join("")).toMatch(/image dropped/);
	});
});

describe("JsRuntime.displayValue images array", () => {
	beforeAll(() => {
		runtime = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "display-images-array-test",
		});
	});

	afterAll(() => {
		runtime.dispose();
	});

	it("renders the `images` array the tool bridge and `image(...)` emit", () => {
		// Before this was handled, the object fell through to the JSON branch and
		// printed its base64 as text instead of rendering.
		const { hooks, displays } = collect();
		runtime.displayValue({ images: [{ mimeType: "image/png", data: PNG_BASE64 }] }, hooks);
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("renders every entry and coerces their data", () => {
		const { hooks, displays } = collect();
		runtime.displayValue(
			{
				images: [
					{ mimeType: "image/png", data: PNG_BYTES },
					{ mimeType: "image/webp", data: PNG_BASE64 },
				],
			},
			hooks,
		);
		expect(displays).toEqual([
			{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
			{ type: "image", data: PNG_BASE64, mimeType: "image/webp" },
		]);
	});

	it("keeps the remaining fields as JSON so a tool result shows text and image", () => {
		const { hooks, displays } = collect();
		runtime.displayValue({ text: "read 28 chars", images: [{ mimeType: "image/png", data: PNG_BASE64 }] }, hooks);
		expect(displays).toEqual([
			{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
			{ type: "json", data: { text: "read 28 chars" } },
		]);
	});

	it("leaves an unrelated `images` field on the JSON path", () => {
		const { hooks, displays } = collect();
		runtime.displayValue({ images: ["diagram.png", "chart.png"] }, hooks);
		expect(displays).toEqual([{ type: "json", data: { images: ["diagram.png", "chart.png"] } }]);
	});

	it("falls back to JSON when every entry has undecodable data", () => {
		const { hooks, displays } = collect();
		runtime.displayValue({ images: [{ mimeType: "image/png", data: { not: "a buffer" } }] }, hooks);
		expect(displays).toHaveLength(1);
		expect(displays[0]?.type).toBe("json");
	});
});
