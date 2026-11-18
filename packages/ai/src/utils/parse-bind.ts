/**
 * Shared `host:port` parser used by the auth-broker and auth-gateway boot
 * paths. Centralized so the two servers can't drift on what they accept (the
 * gateway used to silently allow empty hostnames; this fixes it).
 */

import * as AIError from "../error";

export interface ParsedBind {
	hostname: string;
	port: number;
}

function parsePort(raw: string, bind: string): number {
	if (!/^\d+$/.test(raw)) {
		throw new AIError.ConfigurationError(`Invalid bind '${bind}'; port must be an integer.`);
	}
	const port = Number.parseInt(raw, 10);
	if (!Number.isFinite(port) || port < 0 || port > 65535) {
		throw new AIError.ConfigurationError(`Invalid bind '${bind}'; port out of range.`);
	}
	return port;
}

/**
 * Parse a `host:port` (or bare `port`, which assumes loopback) string.
 *
 * Accepts:
 *   - `"4000"`            → `127.0.0.1:4000`
 *   - `"0.0.0.0:4000"`    → as written
 *   - `"[::1]:4000"`      → as written (brackets retained, Bun handles them)
 *
 * Rejects:
 *   - empty input
 *   - empty hostname (`":4000"`)
 *   - non-integer / out-of-range port
 */
export function parseBind(raw: string): ParsedBind {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new AIError.ConfigurationError("Invalid bind; expected 'host:port' or 'port'.");
	}
	if (/^\d+$/.test(trimmed)) {
		return { hostname: "127.0.0.1", port: parsePort(trimmed, raw) };
	}
	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon < 0) {
		throw new AIError.ConfigurationError(`Invalid bind '${raw}'; expected 'host:port' or 'port'.`);
	}
	const hostPart = trimmed.slice(0, lastColon);
	const portPart = trimmed.slice(lastColon + 1);
	if (hostPart.length === 0) {
		throw new AIError.ConfigurationError(`Invalid bind '${raw}'; host must not be empty.`);
	}
	return { hostname: hostPart, port: parsePort(portPart, raw) };
}

/** The eight 16-bit groups of an IPv6 literal, `::` expanded; undefined when it is not one. */
function ipv6Groups(host: string): number[] | undefined {
	const halves = host.split("::");
	if (halves.length > 2) return undefined;
	const [headText = "", tailText] = halves;
	const parse = (part: string): number[] | undefined => {
		if (part.length === 0) return [];
		const groups: number[] = [];
		for (const group of part.split(":")) {
			if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
			groups.push(Number.parseInt(group, 16));
		}
		return groups;
	};
	const head = parse(headText);
	const tail = tailText === undefined ? [] : parse(tailText);
	if (!head || !tail) return undefined;
	if (tailText === undefined) return head.length === 8 ? head : undefined;
	const zeros = 8 - head.length - tail.length;
	return zeros >= 1 ? [...head, ...Array<number>(zeros).fill(0), ...tail] : undefined;
}

/** `::1` in any spelling: seven zero groups, then 1. `1::` (and every other address) is not loopback. */
function isIpv6Loopback(host: string): boolean {
	const groups = ipv6Groups(host);
	return groups !== undefined && groups.slice(0, 7).every(group => group === 0) && groups[7] === 1;
}

export function isLoopbackBind(hostname: string): boolean {
	const host = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host.startsWith("::ffff:")) return host.slice(7).startsWith("127.");
	if (host.includes(":")) return isIpv6Loopback(host);
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
