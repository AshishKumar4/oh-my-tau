Request user input for one to three short questions and wait for the response.

- Each question has a stable snake_case `id` (answers come back keyed by it), a short `header` (12 or fewer chars), a single-sentence `question`, and 2-3 mutually exclusive `options`, each with a `label` and a one-sentence `description`.
- Put the recommended option first and suffix its label with "(Recommended)".
- Do not include an "Other" option: the client adds a free-form "Other" answer automatically.
