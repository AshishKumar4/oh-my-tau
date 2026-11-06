# Notice

`no-ai-slop` is the single prose-editing skill in this library. It merges three MIT-licensed upstream skills that all removed AI writing patterns and previously competed for the same trigger.

| Source | Author | License | What survived the merge |
|--------|--------|---------|--------------------------|
| [`no-ai-slop`](https://github.com/petergyang/no-ai-slop) | Peter Yang | MIT ([`LICENSE`](LICENSE)) | The entrypoint: two jobs, editing principles, voice preservation, return contract |
| [`humanizer`](https://github.com/blader/humanizer) | Siqi Chen (blader) | MIT ([`licenses/humanizer-MIT.txt`](licenses/humanizer-MIT.txt)) | Most of the pattern catalogue and its before/after examples, the false-positive list, the dash rule, the three output modes |
| [`stop-slop`](https://hvpandya.com) | Hardik Pandya | MIT ([`licenses/stop-slop-MIT.txt`](licenses/stop-slop-MIT.txt)) | False agency, narrator-from-a-distance, vague declaratives, business jargon, emphasis crutches |

The catalogue's Wikipedia-derived patterns come from ["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), maintained by WikiProject AI Cleanup, which is available under CC BY-SA.

Three upstream behaviours were dropped deliberately, not lost:

- **Self-scoring.** `stop-slop` asked the model to rate its own prose 1–10 on five subjective dimensions and revise below 35/50. A self-assigned score is not evidence, and the threshold set no reachable bound.
- **The rules restated as checklists.** `stop-slop`'s Quick Checks and `no-ai-slop`'s `eval.md` re-asked rules that the skill already states. Three checks that catch what a rule-read cannot (claim drift, voice loss, stray dashes) are inline in the workflow instead.
- **Absolute bans.** `stop-slop` banned all adverbs, all em dashes, all wh- openers, and all three-item lists. The catalogue keeps each of these as a judgement-scoped pattern, matching how the other two sources wrote the same rules. The upstream example file contradicted its own em-dash ban, which is what an unscoped rule produces.
