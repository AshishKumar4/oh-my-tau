---
name: thermo-nuclear-code-quality-review
description: Run an extremely strict maintainability review for abstraction quality, giant files, and spaghetti-condition growth. Use for every code review, audit, or pre-merge pass of a change, and for any thermo-nuclear or especially harsh maintainability review.
---

# Thermo-Nuclear Code Quality Review

An unusually strict review of implementation quality, maintainability, abstraction quality, and codebase health.

Above all, be **ambitious** about code structure. Do not merely identify local cleanup opportunities. Actively search for "code judo" moves: restructurings that preserve behavior while making the implementation dramatically simpler, smaller, more direct, and more elegant.

## Core Prompt

Start from this baseline:

> Perform a deep code quality audit of the current branch's changes.
> Rethink how to structure / implement the changes to meaningfully improve code quality without impacting behavior.
> Work to improve abstractions, modularity, reduce Spaghetti code, improve succinctness and legibility.
> Be ambitious, if there is a clear path to improving the implementation that involves restructuring some of the codebase, go for it.
> Be extremely thorough and rigorous. Measure twice, cut once.

## Non-Negotiable Standards

Each standard states what to flag and the remedy to push for.

0. **Be ambitious about structural simplification.** Look for reframings that make whole branches, helpers, modes, conditionals, or layers disappear entirely, and prefer the solution that makes the code feel inevitable in hindsight. Flag refactors that move complexity around without reducing the number of concepts a reader must hold. Remedy: delete a layer of indirection rather than polish it; reframe the state model so conditionals disappear instead of getting centralized; turn special cases into a simpler default flow.

1. **Do not let a PR push a file from under 1k lines to over 1k lines without a very strong reason.** Treat this as a strong code-quality smell by default; when the diff crosses that threshold, explicitly ask whether the code should be decomposed first. Only waive it if there is a compelling structural reason and the resulting file is still clearly organized. Remedy: extract helpers, subcomponents, modules, or split into smaller focused modules.

2. **Do not allow random spaghetti growth in existing code.** Be highly suspicious of new ad-hoc conditionals, scattered special cases, one-off booleans, nullable modes, and "temporary" branching bolted into unrelated flows; that is a design problem, not a stylistic nit, even when it technically works. Remedy: push the logic into a dedicated abstraction, helper, state machine, policy object, or module; collapse duplicate branches into one clearer flow; replace condition chains with a typed model or explicit dispatcher.

3. **Bias toward cleaning the design, not just accepting working code.** If behavior can stay the same while the structure becomes meaningfully cleaner, push for the cleaner version. Do not rubber-stamp "it works" implementations that leave the codebase messier.

4. **Prefer direct, boring, maintainable code over hacky or magical code.** Flag brittle ad-hoc behavior, generic mechanisms that hide simple data-shape assumptions, thin abstractions, identity wrappers, and pass-through helpers that add indirection without buying clarity. Remedy: delete the wrapper and keep the direct flow.

5. **Push hard on type and boundary cleanliness when it affects maintainability.** Question unnecessary optionality, `unknown`, `any`, cast-heavy code, ad-hoc object shapes, and silent fallbacks that paper over an unclear invariant. Remedy: explicit typed models or shared contracts, so the control flow gets simpler.

6. **Keep logic in the canonical layer and reuse existing helpers.** Flag feature logic leaking into shared paths, implementation details leaking through APIs, bespoke helpers where a canonical utility already exists, and logic landing in the wrong package. Remedy: move the logic to the module that already owns the concept; reuse the canonical helper.

7. **Treat unnecessary sequential orchestration and non-atomic updates as design smells when the cleaner structure is obvious.** If independent work is serialized for no good reason, ask whether it should run in parallel; if related updates can leave state half-applied, push for a more atomic structure. Don't over-index on micro-optimizations, but do flag avoidable orchestration complexity that makes the implementation brittle.

## Primary Review Questions

For every meaningful change, ask:

- Is there a "code judo" move that would make this dramatically simpler, needing fewer concepts, branches, or helper layers?
- Does this improve or worsen the local architecture: is the module more coupled, more stateful, or harder to scan than before?
- Is this logic living in the right file, layer, and package?
- Are there repeated conditionals that signal a missing model or missing helper?
- Is this abstraction earning its keep, or is it just a wrapper?
- Is this orchestration more sequential or less atomic than it needs to be?

## Output Expectations

Prioritize findings in this order:

1. Structural code-quality regressions
2. Missed opportunities for dramatic simplification / code-judo restructuring
3. Spaghetti / branching complexity increases
4. Boundary / abstraction / type-contract problems that make the code harder to reason about
5. File-size and decomposition concerns
6. Modularity and abstraction issues
7. Legibility and maintainability concerns

Do not flood the review with low-value nits if there are larger structural issues. Prefer a smaller number of high-conviction comments over a long list of cosmetic notes. Do not settle for "maybe rename this" when the real issue is structural, or for a cleaner version of the same messy idea when a much simpler idea is plausible.

## Review Tone

Be direct, serious, and demanding about quality. Do not be rude, but do not soften major maintainability issues into mild suggestions. If the code is making the codebase messier, say so clearly. If the implementation missed an opportunity for a dramatic simplification, say that clearly too.

## Approval Bar

Do not approve merely because behavior seems correct. Treat each of these as a presumptive blocker unless the author justifies it clearly:

- a lot of incidental complexity preserved when a plausible code-judo move would delete it
- a file pushed from below 1000 lines to above it without a compelling reason
- ad-hoc branching that makes an existing flow more tangled, or feature checks scattered across shared code
- an unnecessary abstraction, wrapper, or cast-heavy contract that makes the design more indirect
- a duplicated canonical helper, or logic placed in the wrong layer when a clear canonical home exists
- an obvious decomposition missed where it would materially improve maintainability

When a blocker stands, leave explicit, actionable feedback and push for a cleaner decomposition.
