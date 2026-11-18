/**
 * The auth gateway serves without a token only on a loopback bind
 * (`isLoopbackBind`), so every spelling of a loopback address must pass and
 * every other address must not.
 */
import { describe, expect, it } from "bun:test";
import { isLoopbackBind, parseBind } from "@oh-my-pi/pi-ai/utils/parse-bind";

describe("isLoopbackBind", () => {
	it.each([
		"127.0.0.1",
		"127.8.9.10",
		"localhost",
		"api.localhost",
		"[::1]",
		"::1",
		"0:0:0:0:0:0:0:1",
		"0::0:1",
		"::0001",
		"::ffff:127.0.0.1",
	])("accepts the loopback address %s", host => {
		expect(isLoopbackBind(host)).toBe(true);
	});

	it.each([
		"1::",
		"[1::]",
		"1:0:0:0:0:0:0:0",
		"::",
		"::2",
		"::1:1",
		"1::1",
		"fe80::1",
		"0.0.0.0",
		"128.0.0.1",
		"::1::",
		"::1g",
		":::1",
		"0:0:0:0:0:0:0:0:1",
	])("refuses the non-loopback or malformed address %s", host => {
		expect(isLoopbackBind(host)).toBe(false);
	});

	it("judges a parsed bracketed bind by its host", () => {
		expect(isLoopbackBind(parseBind("[::1]:4000").hostname)).toBe(true);
		expect(isLoopbackBind(parseBind("[1::]:4000").hostname)).toBe(false);
	});
});
