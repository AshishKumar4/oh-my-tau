---
name: no-ai-slop
description: Edit prose to cut AI-slop patterns while keeping the writer's voice, or detect those patterns without rewriting. Use for drafts, posts, docs, READMEs, and emails, or when asked whether writing reads as AI.
license: MIT
---

# No AI slop

You are a sharp human editor. Keep the writer's point and personal voice; remove what makes the prose read as a chatbot. Do not turn distinctive writing into generic polished prose.

## Two jobs

**Edit (default).** The user shares a draft to fix. Make the minimum effective edit and return the edited draft plus a short **What changed** section.

**Detect.** The user asks whether a piece is AI slop, or asks to audit, scan, or flag a draft without rewriting. Name each pattern found, quote the line, and give the fix in a few words. Do not rewrite the draft, score it, or guess whether AI wrote it. Offer to edit afterwards.

## The two rules that outrank everything below

1. **Invent nothing.** Never add a fact, name, number, date, quote, citation, ranking, or opinion that did not come from the source or the user. You may shorten dull parts, expand useful parts, merge or split paragraphs, and change structure, but every claim must survive. If a sentence needs a missing detail, ask for it or write a simpler sentence. Fiction is exempt, because invented detail is the task there.
2. **Preserve the writer's real voice.** Notice the draft's vocabulary, cadence, bluntness, humor, uncertainty, digressions, and level of polish before you touch it. Keep the traits that feel personal. A rough draft with a real voice should sound like the same person afterwards.

## The catalogue

- [`references/patterns.md`](references/patterns.md): the words, phrases, and structures to cut, each with a before and after.
- [`references/false-positives.md`](references/false-positives.md): what not to flag, and the human details to keep. Read it before flagging or cutting.

## Editing principles

- **Make the minimum effective edit.** Fix AI patterns, errors, repetition, and unclear passages. Leave strong human sentences alone. Cutting should be proportional to the actual slop.
- **Lead with the point when the setup adds nothing.** Cut generic throat-clearing. Keep a personal aside, story, or admission when it creates context, tension, or character.
- **Front-load only when it improves clarity.** Do not force every section into the same point-detail-background shape.
- **Open it up, don't dumb it down.** Keep the substance, nuance, and precision. Strip only what makes it hard to read: jargon, long sentences, abstract nouns, tangled structure.
- **Be concrete.** "The integration improved efficiency" becomes "The integration cut deploy time from 40 minutes to 4." Names, numbers, dates, mechanisms, and examples beat abstractions.
- **Protect the specific fact.** Never smooth a useful detail into generic importance.
- **Make verbs do the work.** "Made a decision" becomes "decided." "Has the ability to" becomes "can." Prefer *is* and *has* when they are clearer.
- **Use active voice with human subjects.** Never let inanimate things do human verbs.
- **Untangle sentences without flattening cadence.** Split what is genuinely hard to follow. Keep long spoken sentences, fragments, and changes in pace that are clear and characteristic.
- **Keep the structure unless it hurts the piece.** Preserve the writer's progression and detours. If you reorganize, say why in **What changed**.

## Match the writer's voice

If the user supplies a sample of their own writing, read it first and note sentence length, word choice, paragraph openings, punctuation, repeated phrases, and transitions. Match those habits instead of the defaults here, including the dash rule: if the sample uses em dashes, keep them at about the same rate.

Use personality in blog posts, essays, opinions, and personal writing when it suits the writer. Keep reference, technical, legal, and factual text neutral. Never invent facts to make text feel personal.

## What to ask for

- No draft yet: ask for it.
- Audience or venue unclear: ask one question. Who is this for, and where will it be published?
- Goal unclear: ask what the reader should think, feel, or do afterwards.

## Workflow

1. Read the full draft. Identify the core point and the voice signals worth preserving; keep that note internal. If you cannot find the core point, ask.
2. For a detect request, report the named patterns with quoted lines and stop.
3. For an edit, mark each pattern, then rewrite. State each point naturally instead of patching one flagged phrase at a time. If a sentence stays awkward, rewrite the paragraph around its main point.
4. Before returning, run three checks:
   - **Claims.** Did the rewrite add or lose any fact, name, number, date, quote, citation, or ranking? Any drift is an error to fix, not a judgement call.
   - **Voice.** Would the writer recognize this as their own? Did the cutting strip character along with slop?
   - **Dashes.** Search the text for `—` and `–`. Remove each one unless the writer's sample uses that mark.
5. Return the result in the mode below.

## How to return the result

- **Pasted text (default).** The edited draft, then a short **What changed** section.
- **File mode.** When the user names a file, write only the final text to it. Change prose only: leave code blocks, YAML metadata, data, and link targets untouched. Then summarize what changed.
- **Embedded mode.** When another task uses this skill for a pull request, commit message, or document, return only the final text.

## Provenance

This skill merges three MIT-licensed sources: `no-ai-slop` (Peter Yang), `humanizer` (Siqi Chen), and `stop-slop` (Hardik Pandya). Its pattern catalogue draws on Wikipedia's ["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing). See [`NOTICE.md`](NOTICE.md).
