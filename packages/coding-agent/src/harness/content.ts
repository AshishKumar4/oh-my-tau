import { escapeExpression, SafeString } from "@oh-my-pi/pi-utils/template";

const renderedEnvelope = Symbol("harness.renderedEnvelope");
// Whitespace around the slash still reads as a tag to the model (`< /system-notice>`). No two
// repetitions may overlap: payloads are untrusted and escaped synchronously on the event loop.
const RESERVED_TAG =
	/<\s*(?:\/\s*)?(?:system(?:[-_][\w-]+)?|irc|task[-_]result|merge[-_]summary|abort[-_]reason|preview|output|error|meta)(?=[\s/>])/gi;

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

/**
 * `carrier` and its envelope marker apart, for moving the marker across a worker
 * thread link (which drops symbol-keyed fields); undefined when it carries none.
 */
export function detachRenderedEnvelope(carrier: object): { value: object; rendered: string } | undefined {
	const rendered = Object.getOwnPropertyDescriptor(carrier, renderedEnvelope)?.value;
	if (!(rendered instanceof SafeString)) return undefined;
	const value: object = Array.isArray(carrier) ? [...carrier] : { ...carrier };
	Reflect.deleteProperty(value, renderedEnvelope);
	return { value, rendered: rendered.toString() };
}

/** Give `to`, a projection of `from` (a job's wire row), the envelope marker `from` carries. */
export function carryRenderedEnvelope<T extends object>(from: object, to: T): T {
	const rendered = Object.getOwnPropertyDescriptor(from, renderedEnvelope)?.value;
	return rendered instanceof SafeString ? withRenderedEnvelope(to, rendered) : to;
}

/** Only unchanged, in-process rendering metadata can preserve an envelope. */
export function getRenderedEnvelope(carrier: object | undefined, text: string): SafeString | undefined {
	if (!carrier) return undefined;
	const rendered = Object.getOwnPropertyDescriptor(carrier, renderedEnvelope)?.value;
	return rendered instanceof SafeString && rendered.toString() === text ? rendered : undefined;
}
