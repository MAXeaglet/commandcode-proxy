const fs = require('node:fs');
const originalFetch = globalThis.fetch;
const PRICING_URL = 'https://commandcode.ai/docs/resources/pricing-limits';
const PRICING_RSC = 'segment:["x",null,{"rows":[{"id":"gemini-3.8-flash","availability":{"individual-go":false}}]}]';

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (url !== PRICING_URL) return originalFetch(input, init);
  const counter = process.env.CC_TEST_PRICING_COUNTER_FILE;
  if (counter) fs.appendFileSync(counter, '1\n');
  const status = Number(process.env.CC_TEST_PRICING_STATUS || 200);
  return new Response(status === 200 ? PRICING_RSC : 'pricing unavailable', {
    status,
    headers: { 'Content-Type': 'text/x-component' },
  });
};
