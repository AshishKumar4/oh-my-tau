import { escapeExpression, SafeString } from "@oh-my-pi/pi-utils/template";

const renderedEnvelope = Symbol("harness.renderedEnvelope");
const RESERVED_TAG =
	/<\/?(?:system(?:[-_][\w-]+)*|irc|task[-_]result|merge[-_]summary|abort[-_]reason|preview|output|error|meta)(?=[\s/>])/gi;

/** Literal data cannot open or close the protocol envelopes around it. */
export function escapeHarnessText(text: string): string {
	return text.replace(RESERVED_TAG, tag => escapeExpression(tag));
}

/** Preserve a producer's rendered envelope without changing public string payloads or JSON schemas. */
export function withRenderedEnvelope<T extends object>(carrier: T, rendered: SafeString | undefined): T {
	if (rendered)
		Object.defineProperty(carrier, renderedEnvelope, { value: rendered, enumerable: true, configurable: true });
	return carrier;
}

/** Only unchanged, in-process rendering metadata can preserve an envelope. */
export function getRenderedEnvelope(carrier: object | undefined, text: string): SafeString | undefined {
	if (!carrier) return undefined;
	const rendered = Object.getOwnPropertyDescriptor(carrier, renderedEnvelope)?.value;
	return rendered instanceof SafeString && rendered.toString() === text ? rendered : undefined;
}
