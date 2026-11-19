/**
 * The public Gemini API's generate routes, served only while the gateway
 * records a harness: `POST /v1beta/models/{model}:generateContent` and
 * `:streamGenerateContent`. The request reaches the recorder, then the route
 * answers it locally with one short model turn so the client finishes. No
 * model is resolved and nothing is forwarded: recording never calls a provider.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { json } from "../http";
import type { AuthGatewayHarnessRecorder } from "../types";

/** Group 1 = model, group 2 = method. */
export const GEMINI_GENERATE_PATH = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/;

const RECORDED_REPLY = "omp recorded this request; no model answered it.";

const RECORDED_TURN = {
	candidates: [{ content: { role: "model", parts: [{ text: RECORDED_REPLY }] }, finishReason: "STOP", index: 0 }],
	usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
};

export async function handleGeminiHarnessRecording(
	recorder: AuthGatewayHarnessRecorder,
	req: Request,
	peer: string,
	method: string,
): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		return json(400, {
			error: { code: 400, message: `Invalid JSON body: ${String(error)}`, status: "INVALID_ARGUMENT" },
		});
	}
	try {
		await recorder({ format: "google-generative-ai", body, headers: req.headers });
	} catch (error) {
		logger.warn("auth-gateway harness recorder failed", {
			format: "google-generative-ai",
			peer,
			error: String(error),
		});
	}
	if (method === "generateContent") return json(200, RECORDED_TURN);
	// The SDKs stream with `alt=sse`; without it the API streams one JSON array.
	if (new URL(req.url).searchParams.get("alt") !== "sse") return json(200, [RECORDED_TURN]);
	return new Response(`data: ${JSON.stringify(RECORDED_TURN)}\r\n\r\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}
