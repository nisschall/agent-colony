// What each model costs: $ per 1M tokens. Cache writes are billed at 1.25x input (5m) or 2x input (1h).
const PRICES = [
  { match: /fable|mythos/, input: 10, output: 50, cacheRead: 0.25 },
  { match: /opus-5-5/, input: 4, output: 20, cacheRead: 0.2 },
  { match: /opus/, input: 5, output: 25, cacheRead: 0.5 },
  { match: /sonnet-4/, input: 3, output: 15, cacheRead: 0.3 },
  { match: /sonnet/, input: 2, output: 10, cacheRead: 0.2 },
  { match: /haiku-4/, input: 1, output: 5, cacheRead: 0.1 },
  { match: /haiku/, input: 0.1, output: 0.5, cacheRead: 0.01 },
  // Codex/GPT rates are a placeholder estimate — edit to match your plan.
  { match: /gpt|codex|^o\d/, input: 1.25, output: 10, cacheRead: 0.125 },
];
const DEFAULT_PRICE = PRICES[1];

function priceFor(model) {
  const name = String(model || '').toLowerCase();
  return PRICES.find((p) => p.match.test(name)) || DEFAULT_PRICE;
}

module.exports = { priceFor };
