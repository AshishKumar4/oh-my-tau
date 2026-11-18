Asks the user one to four multiple-choice questions and returns their answers. Use it only when you are blocked on a decision that is genuinely the user's to make.

- Each question has a short `header` chip (max 12 chars), 2-4 options with a `label` and a `description`, and `multiSelect` to allow several answers.
- Users can always select "Other" to type their own answer, so never add an "Other" option.
- To recommend an option, make it the first option and end its label with "(Recommended)".
- An option's optional `preview` is rendered as markdown under it; use it for mockups or code snippets the user needs to compare.
