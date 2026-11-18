# AI-slop patterns

The catalogue behind the `no-ai-slop` skill. Each entry names a pattern, says why it fails, and shows the fix. Cite entries by name when you report findings.

Read [`false-positives.md`](false-positives.md) before flagging anything here: most of these words are ordinary in isolation, and several are correct in the right register.

## Words and phrases to cut

**Banned outright.** delve, foster, leverage, utilize, facilitate, empower, streamline, robust, cutting-edge, paradigm shift, game changer, this is huge, this changes everything, tapestry, realm, beacon, multifaceted, meticulous, intricate, paramount, transformative, elevate, embark, supercharge, harness, ever-evolving.

**Overused AI words.** actually, additionally, align with, crucial, emphasizing, enduring, enhance, fostering, garner, gate/gated/gating (figurative only; keep established technical usage such as feature gating and CI quality gates), highlight (verb), interplay, intricacies, key (adjective), landscape (abstract noun), pivotal, quietly, showcase, testament, underscore (verb), valuable, vibrant. AI writing uses these far more often than most people do, especially in groups.

**Often-empty adverbs.** just, literally, honestly, simply, actually, truly, fundamentally, importantly, crucially, inherently, inevitably, really, genuinely, deeply, interestingly. Cut them when they add nothing. Keep them when they carry emphasis, uncertainty, contrast, or the writer's spoken rhythm.

**Often-empty phrases.** it's worth noting, it's important to note, at the end of the day, when it comes to, at its core, in today's world, in the age of, in the world of, in a world where, the reality is, the truth is, in terms of, with regard to, going forward, in this article, let's dive in. Cut them when they delay the point. Keep one when it is part of the writer's recognizable voice and the sentence still earns its place.

**Filler swaps.**

- "In order to achieve this goal" → "To achieve this"
- "Due to the fact that it was raining" → "Because it was raining"
- "At this point in time" → "Now"
- "In the event that you need help" → "If you need help"
- "The system has the ability to process" → "The system can process"
- "It is important to note that the data shows" → "The data shows"

**Business jargon.**

| Avoid | Use instead |
|-------|-------------|
| Navigate (challenges) | Handle, address |
| Unpack (analysis) | Explain, examine |
| Lean into | Accept, embrace |
| Landscape (context) | Situation, field |
| Game-changer | Significant, important |
| Double down | Commit, increase |
| Deep dive | Analysis, examination |
| Take a step back | Reconsider |
| Moving forward | Next, from now |
| Circle back | Return to, revisit |
| On the same page | Aligned, agreed |

**Emphasis crutches.** "Full stop." / "Period." / "Let that sink in." / "Make no mistake" / "This matters because" / "Here's why that matters". They add no meaning.

## Content patterns

### 1. Importance puffery (inflated claims about importance and legacy)

**Words to watch:** stands/serves as, is a testament/reminder, a vital/significant/crucial/pivotal/key role/moment, underscores/highlights its importance, reflects broader, symbolizing its ongoing/enduring/lasting, setting the stage for, marks a shift, key turning point, evolving landscape, focal point, indelible mark, deeply rooted
**Problem:** ordinary details are claimed to mark a major change, prove a legacy, or reflect a broad trend.
**Before:**
> The Statistical Institute of Catalonia was officially established in 1989, marking a pivotal moment in the evolution of regional statistics in Spain. This initiative was part of a broader movement across Spain to decentralize administrative functions and enhance regional governance.
**After:**
> The Statistical Institute of Catalonia was established in 1989, part of a wider decentralization of administrative functions in Spain.

State the fact and let the reader judge whether it matters: "The launch marks a pivotal moment for the company" becomes "The launch is the company's first paid product."

### 2. Name-dropping to prove importance

**Words to watch:** independent coverage, local/regional/national media outlets, written by a leading expert, active social media presence
**Problem:** publications and follower counts are listed to prove that a person matters, with no useful context.
**Before:**
> Her views have been cited in The New York Times, BBC, Financial Times, and The Hindu. She maintains an active social media presence with over 500,000 followers.
**After:**
> Her views have been cited in The New York Times and the BBC.

If the source explains what the person said and where, keep that citation. Do not invent context to justify a shorter version.

### 3. Superficial analysis with -ing phrases

**Words to watch:** highlighting, underscoring, emphasizing, ensuring, reflecting, symbolizing, contributing to, cultivating, fostering, encompassing, showcasing
**Problem:** a trailing -ing clause pretends to explain what a simple fact means.
**Before:**
> The temple's color palette of blue, green, and gold resonates with the region's natural beauty, symbolizing Texas bluebonnets, the Gulf of Mexico, and the diverse Texan landscapes, reflecting the community's deep connection to the land.
**After:**
> The temple is painted blue, green, and gold, colors meant to evoke Texas bluebonnets and the Gulf of Mexico.

"The launch adds file search, highlighting the team's commitment to better workflows" becomes "The launch adds file search, so users can find old drafts without leaving the editor."

### 4. Sales language

**Words to watch:** boasts a, vibrant, rich (figurative), profound, enhancing its, showcasing, exemplifies, commitment to, natural beauty, nestled, in the heart of, groundbreaking (figurative), renowned, breathtaking, must-visit, stunning
**Problem:** the prose reads like an advertisement, especially about places, culture, products, or organizations.
**Before:**
> Nestled within the breathtaking region of Gonder in Ethiopia, Alamata Raya Kobo stands as a vibrant town with a rich cultural heritage and stunning natural beauty.
**After:**
> Alamata Raya Kobo is a town in the Gonder region of Ethiopia.

### 5. Weasel attribution (vague sources)

**Words to watch:** industry reports, observers have cited, experts agree, experts argue, some critics argue, many argue, widely regarded as, studies show, several sources (when few are cited)
**Problem:** a claim is assigned to unnamed experts, critics, reports, or observers.
**Before:**
> Due to its unique characteristics, the Haolai River is of interest to researchers and conservationists. Experts believe it plays a crucial role in the regional ecosystem.
**After:**
> Researchers and conservationists study the Haolai River for its unusual characteristics.

Name a real source when the text provides one. Otherwise remove the claim, or ask the user for the source. Never invent one.

### 6. Formulaic challenges and outlook sections

**Words to watch:** Despite its... faces several challenges, Despite these challenges, Challenges and Legacy, Future Outlook
**Problem:** a stock section about challenges, future prospects, or continued growth repeats vague claims instead of adding facts.
**Before:**
> Despite its industrial prosperity, Korattur faces challenges typical of urban areas, including traffic congestion and water scarcity. Despite these challenges, with its strategic location and ongoing initiatives, Korattur continues to thrive as an integral part of Chennai's growth.
**After:**
> Korattur has recurring traffic congestion and water shortages.

Add dates or public actions only when they come from the source or the user.

### 7. Faux-insight setups

**Phrases to watch:** This is the part most people skip, What most people get wrong, Here's what nobody tells you, The part everyone misses
**Problem:** the setup flatters the writer as the lone expert and delays the claim.
**Before:**
> The part everyone misses: distribution is the real moat.
**After:**
> Distribution is the moat.

### 8. Pretending to reveal a deeper truth

**Phrases to watch:** the real question is, at its core, in reality, what really matters, fundamentally, the deeper issue, the heart of the matter
**Problem:** an ordinary point is dressed as a hidden truth.
**Before:**
> The real question is whether teams can adapt. At its core, what really matters is organizational readiness.
**After:**
> The question is whether teams can adapt. That mostly depends on whether the organization is ready to change its habits.

### 9. Formulaic sayings

**Words to watch:** X is the Y of Z, X becomes a trap, X is not a tool but a mirror, the language of, the currency of, the architecture of
**Problem:** an ordinary claim is turned into a saying that sounds deep and adds no detail.
**Before:**
> Symmetry is the language of trust. Efficiency becomes a trap when teams forget the human layer.
**After:**
> Symmetric layouts often feel more predictable to users. Teams can over-optimize workflows and miss how people actually use them.

### 10. Answering objections no one raised

**Phrases to watch:** This isn't (mainly/really) about, I'm not saying/arguing/trying to, To be clear, Don't get me wrong, This is not to say, You could argue this differently but, Some might say... but
**Problem:** the text answers an objection that never appears in it. Watch for an unattributed statement about what the writer does not mean, especially when the topic appears nowhere else. A direct claim such as "the API is not thread-safe" is not this pattern.
**Before:**
> This isn't mainly about prompt length, and I'm not arguing that documentation doesn't matter. You could categorize the problem another way, but the issue is whether the agent can use the instruction when it acts.
**After:**
> The issue is whether the agent can use the instruction when it acts.

Remove only the unsupported defense. If it contains a real claim, state that claim directly. Keep an objection when the text names its source or answers it in full.

### 11. Rejecting fake alternatives

**Phrases to watch:** A tempting option would be, One might be tempted to, An obvious approach would be, You might think... but, It would be easy to just, Some would suggest
**Problem:** an option no reader would consider is introduced, rejected in a clause, and never mentioned again. It usually records an abandoned drafting idea.
**Before:**
> Session tokens are rotated every 24 hours. A tempting approach would be to rotate them by restarting the auth service on a cron job, but that would drop every active session. Rotation happens in place, and clients refresh transparently.
**After:**
> Session tokens are rotated every 24 hours, in place, and clients refresh transparently.

One rejected option may be valid. Several short, unrelated rejections are a stronger sign. Ask what new information each sentence adds.

### 12. Writing about the previous version

**Problem:** documentation and comments should describe current behavior. Mention the previous version only in change logs, release notes, migration guides, and other documents about change.
**Before:**
> This function was added to replace the previous approach of iterating through all items, which caused O(n²) performance.
**After:**
> This function uses a hash map for O(1) lookups, avoiding the O(n²) cost of naive iteration.

## Language and grammar patterns

### 13. Fake-strong verbs (avoiding *is* and *are*)

**Words to watch:** serves as, stands as, marks, represents, boasts, features, offers
**Problem:** simple verbs such as *is*, *are*, and *has* are replaced with longer phrases.
**Before:**
> Gallery 825 serves as LAAA's exhibition space for contemporary art. The gallery features four separate spaces and boasts over 3,000 square feet.
**After:**
> Gallery 825 is LAAA's exhibition space for contemporary art. The gallery has four rooms totaling 3,000 square feet.

Prefer a plain noun list over a container metaphor: "The app serves as a centralized hub for sponsor management" becomes "The app tracks sponsors, drafts, due dates, and approvals in one place."

### 14. Binary contrasts (not X but Y) and clipped negative endings

**Problem:** forms such as "Not only... but...", "It's not just X, it's Y", "The question isn't X, it's Y", "It feels like X. It's actually Y", "stops being X and starts being Y". The reversal is telegraphed and the reader waits through the negation for the claim. The same habit produces clipped endings such as "no guessing" in place of a clear clause.
**Before:**
> It's not just about the beat riding under the vocals; it's part of the aggression and atmosphere. It's not merely a song, it's a statement.
**After:**
> The heavy beat adds to the aggressive tone.
**Before (tailing negation):**
> The options come from the selected item, no guessing.
**After:**
> The options come from the selected item without forcing the user to guess.

State Y directly: "The question isn't the model. It's the eval." becomes "The eval matters more than the model."

### 15. Negative listing

**Problem:** listing what something is *not* before revealing what it *is*. "Not a X. Not a Y. A Z." / "It wasn't X. It wasn't Y. It was Z."
**Fix:** state Z. The reader does not need the runway.

### 16. Forced groups of three

**Problem:** ideas are forced into triples to sound complete.
**Before:**
> The event features keynote sessions, panel discussions, and networking opportunities. Attendees can expect innovation, inspiration, and industry insights.
**After:**
> The event includes talks and panels. There's also time for informal networking between sessions.

Use the number of items the meaning needs. A real triple is fine; a manufactured one is padding.

### 17. Synonym cycling and repeated sentence openings

**Problem:** repetition is handled by rule instead of by ear. The same person or thing keeps getting renamed, or several sentences open with the same subject.
**Before (synonym cycling):**
> The protagonist faces many challenges. The main character must overcome obstacles. The central figure eventually triumphs. The hero returns home.
**After:**
> The protagonist faces many challenges but eventually triumphs and returns home.
**Before (repeated openings):**
> She noted the door. She noted the lock on it. She filed both away.
**After:**
> She noted the door and its lock, then filed both away.

Use one clear name for one subject. Fix the repeated sentence pattern, not the repeated word: the remaining sentence may still start with "She." If the clear word is right, repeat it.

### 18. False *from X to Y* ranges

**Problem:** "from X to Y" is used when X and Y do not form a real range.
**Before:**
> Our journey through the universe has taken us from the singularity of the Big Bang to the grand cosmic web, from the birth and death of stars to the enigmatic dance of dark matter.
**After:**
> The book covers the Big Bang, star formation, and current theories about dark matter.

### 19. Passive voice and missing subjects

**Problem:** the actor is hidden or the subject is dropped. Use active voice when it makes the actor and action clearer.
**Before:**
> No configuration file needed. The results are preserved automatically.
**After:**
> You do not need a configuration file. The system preserves the results automatically.

Common repairs: "X was created" → name who created it. "It is believed that" → name who believes it. "The decision was reached" → name who decided.

### 20. False agency

**Problem:** inanimate things are given human verbs, which lets the sentence avoid naming the actor.

| Pattern | Why it fails |
|---------|--------------|
| "a complaint becomes a fix" | The complaint did nothing. Someone fixed it. |
| "a bet lives or dies in days" | Someone kills the project or ships it. |
| "the decision emerges" | Someone decides. |
| "the culture shifts" | People change behavior. |
| "the conversation moves toward" | Someone steers it. |
| "the data tells us" | Someone reads it and draws a conclusion. |
| "the market rewards" | Buyers pay for things. |

**Fix:** name the human. "The team fixed it that week" beats "the complaint becomes a fix." If no specific person fits, use "you" to put the reader in the seat.

### 21. Narrator-from-a-distance

**Problem:** the writing floats above the scene instead of putting the reader in it: "Nobody designed this." "People tend to..." "This happens because..."
**Fix:** put the reader in the room. "You don't sit down one day and decide to..." beats "Nobody designed this." Prefer "you" over "people", specifics over abstractions.

### 22. Vague declaratives

**Problem:** a sentence announces importance without naming the thing: "The reasons are structural." "The implications are significant." "The stakes are high." Lazy extremes (every, always, never, everyone, nobody) do the same vague work while claiming false authority.
**Fix:** name the specific reason, implication, or stake, or cut the sentence. Do not delete a quantifier that carries meaning ("most teams" is a claim, not a hedge).

### 23. Too many qualifiers

**Phrases to watch:** to be fair, it's also possible, could potentially, might arguably, in some cases it may, this is an inference
**Problem:** repeated editing stacks one qualifier on another until every claim sounds uncertain.
**Before:**
> It could potentially possibly be argued that the policy might have some effect on outcomes.
**After:**
> The policy may affect outcomes.

Keep a qualifier when the source supports it and the meaning needs it. Remove caveats that only repair an earlier overstatement.

### 24. Too many hyphenated word pairs

**Words to watch:** third-party, cross-functional, client-facing, data-driven, decision-making, well-known, high-quality, real-time, long-term, end-to-end
**Problem:** these pairs get hyphenated everywhere. Keep the hyphen before a noun when grammar needs it; drop it after the noun.
**Before:**
> The cross-functional team delivered a high-quality, data-driven report. The team is cross-functional, the report is high-quality, and the methodology is data-driven.
**After:**
> The cross-functional team delivered a high-quality, data-driven report. The team is cross functional, the report is high quality, and the methodology is data driven.

## Style and formatting patterns

### 25. Em and en dashes (the dash rule)

**Rule:** the final text must not contain em dashes (—) or en dashes (–) unless the writer's sample uses them. Replace the dash with a period, comma, colon, or parentheses, or rewrite the sentence. Also check spaced dashes (` — `) and double hyphens (` -- `) used as dashes. In longer drafts, 1–2 are acceptable when they clearly beat every other mark; in short copy, use none.
**Before:**
> The term is primarily promoted by Dutch institutions—not by the people themselves. You don't say "Netherlands, Europe" as an address—yet this mislabeling continues—even in official documents.
**After:**
> The term is primarily promoted by Dutch institutions, not by the people themselves. You don't say "Netherlands, Europe" as an address, yet this mislabeling continues in official documents.
**Before:**
> The new policy — announced without warning — affects thousands of workers. The changes -- long overdue according to critics -- will take effect immediately.
**After:**
> The new policy, announced without warning, affects thousands of workers. The changes, long overdue according to critics, will take effect immediately.

### 26. Too much bold text

**Problem:** words and phrases are bolded without a clear reason, including mid-sentence emphasis.
**Before:**
> It blends **OKRs (Objectives and Key Results)**, **KPIs (Key Performance Indicators)**, and visual strategy tools such as the **Business Model Canvas (BMC)** and **Balanced Scorecard (BSC)**.
**After:**
> It blends OKRs, KPIs, and visual strategy tools like the Business Model Canvas and Balanced Scorecard.

### 27. Lists with bold mini-headings

**Problem:** every list item starts with a bold label and a colon, and the item then repeats the label.
**Before:**
> - **User Experience:** The user experience has been significantly improved with a new interface.
> - **Performance:** Performance has been enhanced through optimized algorithms.
> - **Security:** Security has been strengthened with end-to-end encryption.
**After:**
> The update improves the interface, speeds up load times through optimized algorithms, and adds end-to-end encryption.

### 28. Formatting slop

**Problem:** emoji in headings, bullet lists where two sentences of prose would read better, and headers over two-sentence sections. Format should follow the content, not decorate it.
**Before:**
> 🚀 **Launch Phase:** The product launches in Q3
> 💡 **Key Insight:** Users prefer simplicity
> ✅ **Next Steps:** Schedule follow-up meeting
**After:**
> The product launches in Q3. User research showed a preference for simplicity. Next step: schedule a follow-up meeting.

### 29. Title case in headings

**Before:**
> ## Strategic Negotiations And Global Partnerships
**After:**
> ## Strategic negotiations and global partnerships

### 30. Curly quotation marks

**Problem:** curly quotes (“...”) appear where the writer or the target format uses straight quotes ("...").
**Before:**
> He said “the project is on track” but others disagreed.
**After:**
> He said "the project is on track" but others disagreed.

### 31. A heading repeated in the first sentence

**Problem:** a heading is followed by a one-line paragraph that restates it.
**Before:**
> ## Performance
>
> Speed matters.
>
> When users hit a slow page, they leave.
**After:**
> ## Performance
>
> When users hit a slow page, they leave.

## Openings, endings, and rhythm

### 32. Throat-clearing openers

**Phrases to watch:** Here's the thing, Here's what I mean, Here's why, Here's what I find interesting, Let me be clear, I'll be honest, The uncomfortable truth is, It turns out, Can we talk about, I'll say it again
**Problem:** the sentence announces that a point is coming instead of making it. Any "here's what/this/that" construction is throat-clearing.
**Fix:** cut it and state the point.

### 33. Fake-candid openings

**Phrases to watch:** Honestly?, Look, The thing is, Let's be honest, Real talk, used as standalone hooks or staged pauses before an ordinary point.
**Before:**
> Is it worth the price? Honestly? It depends on how often you'll use it.
**After:**
> Whether it's worth the price depends on how often you'll use it.

### 34. Announcing the next point (meta-commentary)

**Phrases to watch:** Let's dive in, let's explore, let's break this down, here's what you need to know, now let's look at, without further ado, heads up, quick note, The rest of this essay explains, In this section we'll, As we'll see
**Problem:** the text announces the next point, or narrates its own structure, instead of moving. A casual phrase such as "one thing that bit me" has the same problem: remove the announcement, not just its formal tone.
**Before:**
> Let's dive into how caching works in Next.js. Here's what you need to know.
**After:**
> Next.js caches data at multiple layers, including request memoization, the data cache, and the router cache.
**Before (casual register):**
> One thing that bit me hard, so pay attention to this part: the webpack dev server doesn't send the CORS header by default.
**After:**
> The webpack dev server doesn't send the CORS header by default.

### 35. Colon reveals

**Problem:** a noun phrase, a colon, then a lowercase dramatic reveal: "The detail that makes it work: a separate agent grades it." "The best part: it learns."
**Fix:** rewrite as a plain sentence ("A separate agent does the grading, which is what makes it work"). Use colons for lists, labels, and quotes, not fake drama. Prefer sentence case after a colon unless grammar, a proper noun, a title, or code requires otherwise.

### 36. Rhetorical setups

**Phrases to watch:** What if I told you, Think about it:, Plot twist:, Spoiler:, Hint:, and self-answered "Question? Answer." pairs
**Problem:** the setup announces insight rather than delivering it, and questions answered immediately add no tension.
**Fix:** drop the setup and make the point. "And that's okay" grants permission nobody asked for; cut it too.

### 37. Forced punchlines and dramatic fragments

**Problem:** each sentence is turned into a closing line. One short sentence adds emphasis; a row of fragments feels forced.
**Before:**
> Then AlphaEvolve arrived. It had no preference for symmetry. No aesthetic prior. No nostalgia for human taste. The old rules were gone.
**After:**
> AlphaEvolve changed the search because it did not favor symmetry or human-looking designs. That made some of the older assumptions less useful.

"[Noun]. That's it. That's the [thing]." is the same move in miniature.

### 38. Robotic rhythm

**Problem:** repeated sentence shapes, identical paragraph structures, metronomic mid-length cadence, and every paragraph ending on a punchy one-liner.
**Fix:** vary sentence length and paragraph endings. Vary the shape only when it helps the point; do not impose variation as a rule of its own.

### 39. Fake-profound kickers

**Problem:** a final "deep" line turns the point into a cute metaphor, aphorism, or mic-drop.
**Fix:** delete it. Do not rewrite it into a better metaphor and do not preserve its rhythm. End on the clearest concrete sentence already in the draft. If the ending needs closure, add a plain takeaway or next action.

### 40. Summary-recap endings

**Phrases to watch:** In conclusion, Ultimately, Overall, or a final paragraph that restates the piece
**Problem:** the reader was just there.
**Fix:** end on the last concrete point, takeaway, or next action.

### 41. Generic positive endings

**Problem:** the piece ends on vague optimism instead of the last useful fact.
**Before:**
> The future looks bright for the company. Exciting times lie ahead as they continue their journey toward excellence. This represents a major step in the right direction.
**After:**
> Cut the paragraph. End on the last concrete fact. If the source states real plans, use those.

## Chatbot patterns

### 42. Chatbot text left in the answer

**Phrases to watch:** I hope this helps, Of course!, Certainly!, You're absolutely right!, Would you like..., Want me to...?, Should I continue?, let me know, here is a...
**Problem:** a chatbot's greeting, offer, or closing remains in text that should stand on its own.
**Before:**
> Here is an overview of the French Revolution. I hope this helps! Let me know if you'd like me to expand on any section.
**After:**
> The French Revolution began in 1789 when financial crisis and food shortages led to widespread unrest.

### 43. Knowledge-limit disclaimers and guesses

**Phrases to watch:** as of [date], up to my last training update, while specific details are limited, based on available information, not publicly available, maintains a low profile, prefers to stay out of the spotlight, likely [grew up/studied/began], it is believed that
**Problem:** the text mentions where the model's knowledge ends, or reports that no source was found and then fills the gap with a plausible guess.
**Before (cutoff disclaimer):**
> While specific details about the company's founding are not extensively documented in readily available sources, it appears to have been established sometime in the 1990s.
**After:**
> The company's founding date is not documented in the available sources. (Or cut the sentence. State a date only if a source provides one.)
**Before (speculative gap-fill):**
> Information about her early life is not publicly available, suggesting she maintains a low profile and keeps personal details private. She likely grew up in a middle-class household, which shaped her later interest in education reform.
**After:**
> Her early life is not documented in the available sources. (Or omit the section.)

State what the source does not show, or remove the sentence. Never present a guess as a fact.

### 44. Overly agreeable tone

**Problem:** the text praises the user or agrees before giving the answer.
**Before:**
> Great question! You're absolutely right that this is a complex topic. That's an excellent point about the economic factors.
**After:**
> The economic factors you mentioned are relevant here.

## Sources

- Most content, language, style, and chatbot entries, their before/after pairs, the overused-word list, and the dash rule come from Wikipedia's ["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), maintained by WikiProject AI Cleanup, by way of the `humanizer` skill (Siqi Chen, MIT).
- False agency, narrator-from-a-distance, vague declaratives, business jargon, and emphasis crutches come from the `stop-slop` skill (Hardik Pandya, MIT).
- Faux-insight setups, colon reveals, negative listing, robotic rhythm, fake-profound kickers, summary-recap endings, formatting slop, the banned-word list, and the editing principles come from `no-ai-slop` (Peter Yang, MIT).

Several entries merge two sources that named the same pattern; where they disagreed on how absolute a rule was, the judgement-scoped wording won.

Full license texts are in [`../NOTICE.md`](../NOTICE.md).

Wikipedia's summary of why these patterns exist: "LLMs use statistical algorithms to guess what should come next. The result tends toward the most statistically likely result that applies to the widest variety of cases."
