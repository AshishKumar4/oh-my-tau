{{!--
	Vendor-shaped `exec` description for the Codex harness profile.

	Everything from "Run JavaScript code" down to `yield_control()` is
	EXEC_DESCRIPTION_TEMPLATE, reproduced verbatim from codex-rs
	`code-mode-protocol/src/description.rs:15` (Codex 0.154.0, Copyright
	OpenAI, Apache-2.0 <https://www.apache.org/licenses/LICENSE-2.0>). It is
	the fixed head a codex-profile model was post-trained against, so it is
	copied rather than paraphrased; `build_exec_tool_description` at :253
	assembles the sections below it the same way.

	Known gaps against omp's isolate, left in the vendor text rather than
	paraphrased away: `max_output_tokens` in the `// @exec:` pragma is inert
	(`yield_time_ms` is honored as the cell timeout), `image`/`audio`/
	`generatedImage` render URLs rather than fetching remote media, and
	`store`/`load` live in a per-session Map. The rest of the vendor surface —
	`exit`, `text`, `notify`, `ALL_TOOLS`, `yield_control`, and an enumerable
	`tools` proxy — is installed per run by the worker when the profile is
	codex (`eval/js/worker-core.ts` → `__omp_install_codex_exec__`).
	`{{nestedDeclarations}}` splices the vendor's own nested `###` sections
	verbatim between this head and omp's bridged tools when a capture is
	served; absent a capture the slot renders empty.
--}}
Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.
- All nested tools are available on the global `tools` object, for example `await tools.exec_command(...)`. Tool names are exposed as normalized JavaScript identifiers, for example `await tools.mcp__ologs__get_profile(...)`.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw JavaScript -- no Node, no file system, no network access, no console.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.
- `yield_time_ms` asks `exec` to yield early if the script is still running. Defaults to 10000 ms.
- `max_output_tokens` sets the token budget for direct `exec` results. Defaults to 10000 tokens.
- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- `exit()`: Immediately ends the current script successfully (like an early return from the top level).
- `text(value: string | number | boolean | undefined | null)`: Appends a text item. Non-string values are stringified with `JSON.stringify(...)` when possible.
- `image(imageUrlOrItem: string | { image_url: string; detail?: "auto" | "low" | "high" | "original" | null } | ImageContent, detail?: "auto" | "low" | "high" | "original" | null)`: Appends an image item. `image_url` should be a base64-encoded `data:` URL. To forward an MCP tool image, pass an individual `ImageContent` block from `result.content`, for example `image(result.content[0])`. MCP image blocks may request detail with `_meta: { "codex/imageDetail": "original" }`. When provided, the second `detail` argument overrides any detail embedded in the first argument.
- `audio(audioUrlOrItem: string | { audio_url: string } | AudioContent)`: Appends an audio item. `audio_url` should be a base64-encoded `data:` URL. To forward an MCP tool audio block, pass an individual `AudioContent` block from `result.content`, for example `audio(result.content[0])`.
- `generatedImage(result: { image_url: string; output_hint?: string })`: Appends an image-generation result and its optional output hint. HTTP(S) URLs are not supported.
- `store(key: string, value: any)`: stores a serializable value under a string key for later `exec` calls in the same session.
- `load(key: string)`: returns the stored value for a string key, or `undefined` if it is missing.
- `notify(value: string | number | boolean | undefined | null)`: immediately injects an extra `custom_tool_call_output` for the current `exec` call. Values are stringified like `text(...)`.
- `setTimeout(callback: () => void, delayMs?: number)`: schedules a callback to run later and returns a timeout id. Pending timeouts do not keep `exec` alive by themselves; await an explicit promise if you need to wait for one.
- `clearTimeout(timeoutId?: number)`: cancels a timeout created by `setTimeout`.
- `ALL_TOOLS`: metadata for the enabled nested tools as `{ name, description }` entries.
- `yield_control()`: yields the accumulated output to the model immediately while the script keeps running.{{nestedDeclarations}}
{{#each tools}}

### `{{identifier}}`{{#if alias}} (`{{alias}}`){{/if}}
{{#if summary}}
{{summary}}
{{/if}}

exec tool declaration:
```ts
declare const tools: { {{declaration}} };
```
{{/each}}
{{#if preludeDeclarations}}

Additional globals:
```ts
{{preludeDeclarations}}
```
{{/if}}
