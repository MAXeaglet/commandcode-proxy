const fs = require('node:fs');
const originalFetch = globalThis.fetch;
const PRICING_URL = 'https://commandcode.ai/docs/resources/pricing-limits';
const PRICING_RSC = 'segment:["x",null,{"rows":[{"id":"gemini-3.8-flash","availability":{"individual-go":false}},{"id":"claude-haiku-4-5","name":"Claude Haiku 4.5","availability":{"individual-go":false}}]}]';

// 状态码优先读 CC_TEST_PRICING_STATUS_FILE（测试中途可改），否则读 CC_TEST_PRICING_STATUS。
// CC_TEST_PRICING_FAIL_FIRST=N：前 N 次请求返回 503，之后按上面的状态码。
let seen = 0;
function currentStatus() {
  const file = process.env.CC_TEST_PRICING_STATUS_FILE;
  if (file && fs.existsSync(file)) return Number(fs.readFileSync(file, 'utf8').trim() || 200);
  return Number(process.env.CC_TEST_PRICING_STATUS || 200);
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (url !== PRICING_URL) return originalFetch(input, init);
  const counter = process.env.CC_TEST_PRICING_COUNTER_FILE;
  if (counter) fs.appendFileSync(counter, '1\n');
  seen++;
  const status = seen <= Number(process.env.CC_TEST_PRICING_FAIL_FIRST || 0) ? 503 : currentStatus();
  return new Response(status === 200 ? PRICING_RSC : 'pricing unavailable', {
    status,
    headers: { 'Content-Type': 'text/x-component' },
  });
};
