# Longer, More Reliable Answers

Choose a reply budget up to the model-specific service limit. Quote and Send use the same budget. Published provider/catalog caps win; unknown models use a conservative output ceiling. The service maximum is 32,768 output tokens, not a guarantee of answer length. Reasoning can consume the output budget.

The released request builder preserves the complete included conversation rather than silently dropping older turns. Requests above 200 messages, 240,000 text characters or the conservative model context allowance are rejected before reservation or provider calls. The UTF-8 context estimate and image allowance are conservative approximations, not provider-specific tokenization. Document excerpt limits and normal HTTP limits remain.

Interrupted replies retain available content and finish reasons. Prepare continuation only fills a draft; review its new estimate and explicitly Send to make another request. Timeouts and cancellation may incur charges under the existing receipt/recovery rules. Provider deadlines remain unchanged, so even larger budgets can stop early. A compatible backup must fit both context and output limits. Private and ephemeral content is not newly saved.
