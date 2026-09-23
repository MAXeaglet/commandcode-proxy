import { isIP } from 'node:net';
import { proxyFetch } from './proxy.mjs';

const targets = [
  { url: 'http://ip-api.com/json/?lang=en', parse: value => value?.status === 'success' ? value.query : null },
  { url: 'http://api64.ipify.org?format=json', parse: value => value?.ip },
];

async function readJSON(response) {
  if (!response.ok || !response.body) throw new Error('probe_response');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 16 * 1024) throw new Error('probe_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const shortText = value => typeof value === 'string' && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;

// Mirrors Sub2API's exit-IP probe: fixed targets, first with geo data, then an IP-only fallback.
export async function probeProxy(proxyUrl, signal) {
  const checked_at = Date.now();
  for (const target of targets) {
    const started = Date.now();
    try {
      const response = await proxyFetch(target.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)].filter(Boolean)) }, proxyUrl);
      const data = await readJSON(response);
      const exit_ip = target.parse(data);
      if (typeof exit_ip !== 'string' || !isIP(exit_ip)) throw new Error('invalid_exit_ip');
      return {
        success: true, exit_ip,
        country_code: /^[A-Z]{2}$/.test(data.countryCode || '') ? data.countryCode : null,
        country: shortText(data.country), region: shortText(data.regionName), city: shortText(data.city),
        latency_ms: Date.now() - started, checked_at,
      };
    } catch { if (signal?.aborted) break; }
  }
  return { success: false, message: '代理出口检测失败，请检查代理连接', checked_at };
}
