# False positives and details to keep

Read this before flagging or cutting anything from [`patterns.md`](patterns.md). Most watched words are ordinary in isolation; the tell is several patterns stacked in one passage. One em dash proves nothing.

## What not to flag

A person may use any of these. None is evidence by itself.

- **Perfect grammar and consistent style.** Many writers are professionals or have been edited. Polish is not AI.
- **Mixed casual and formal registers.** This can reflect the writer's field, age, or habits.
- **"Bland" or "robotic" prose.** AI prose has *specific* tells. Generic dryness without them is just dry writing.
- **Formal or academic words.** The overused-word list names specific words. Do not simplify every formal word.
- **Letter-style openings or sign-offs on a comment.** Salutations predate ChatGPT by centuries.
- **Common transition words in isolation.** *Additionally*, *moreover*, *consequently* are AI-coded only when piled up. One *however* is not a tell.
- **Curly quotes alone.** macOS, Word, Google Docs, and most CMSes auto-curl by default. They count only when stacked with other tells.
- **Em dashes alone.** Many editors and journalists use them often. They are evidence only alongside formulaic sales-y rhythm.
- **One short sentence for emphasis.** Flag dramatic fragments only when several appear in a row.
- **Deliberate repeated openings.** Writers repeat an opening to build rhythm or pressure, as in "She came. She saw. She conquered." Change it only when the repetition adds nothing.
- **"Honestly" or "look" mid-sentence.** Ordinary in casual writing. The tell is the standalone theatrical opener.
- **Useful limits and disclaimers.** Keep scope statements, legal and safety notices, real corrections, named objections, replies, and FAQ answers.
- **Real alternatives.** Keep options a reader may actually consider in a design document, tutorial, or argument. Remove only an unlikely option the text dismisses and never uses again.
- **Real technical usage.** Keep established senses of watched words: feature gating, CI quality gates, a landscape orientation, a robust statistic.
- **Unsourced claims.** Most of the web is unsourced. Missing citations prove nothing.
- **Correct, complex formatting.** Visual editors and templates produce clean output without any AI.
- **Secondhand text.** Never rewrite a watched phrase inside a quotation, title, proper name, or an example where the phrase is being discussed rather than used.

## Human details to keep

These carry the writer's voice. Keep them unless they damage the meaning.

- **Specific, unusual details.** A real address, an odd quote, "the lawyer who used to work upstairs from my dentist."
- **Mixed feelings and unresolved tension.** "I think this is mostly good, but it bothers me, and I can't fully explain why."
- **Dated, era-bound references.** Slang, memes, and in-jokes tied to a year and a subculture.
- **Deliberate first-person choices.** A cut or word the writer can explain.
- **Variety in sentence length.** Real writing alternates short and long; AI tends toward an even mid-length cadence.
- **Genuine asides, parentheticals, and self-corrections.** "(I keep wanting to say 'almost' here, but it really was certain.)"
- **Strong opinions, blunt language, humor, profanity, and honest admissions** that belong to the writer. Do not replace them with safer or more professional wording.
- **Personal setup that earns its place.** An aside, story, or admission that creates context, tension, or character is not throat-clearing.
- **Edits made before November 30, 2022,** the date ChatGPT launched publicly.

## Detecting rather than editing

When the user asks whether a draft reads as AI, name the patterns and quote the lines. Do not guess whether a model wrote it. AI detectors guess; named patterns are evidence the user can check for themselves.
