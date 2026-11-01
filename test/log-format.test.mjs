// 日志时间戳契约：本地时间 [YYYY-MM-DD HH:MM:SS.mmm]，不带 ISO 8601 的 T 分隔符与 Z(UTC) 后缀。
// 子进程强制 TZ=Asia/Kathmandu（+05:45，无夏令时），因此即使 CI 主机是 UTC，
// "UTC 冒充本地" 的实现（toISOString().replace('T',' ').replace('Z','')）也会被时间差抓住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { setup } from './helpers.mjs';

const TZ = 'Asia/Kathmandu';
const TZ_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;   // +05:45，无 DST

test('日志时间戳为本地时间 [YYYY-MM-DD HH:MM:SS.mmm]，无 T/Z 标记', async () => {
  const s = await setup({ env: { TZ } });
  try {
    // 启动日志在 /health 可用前就已写出，但 stdout 事件可能晚到；轮询到完整形状出现，
    // 避免把被 chunk 切断的半行当成日志（只匹配整行形状，不匹配前缀）。
    const SHAPE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\] \[(info|warn|error)\] /;
    let line;
    let m;
    for (let i = 0; i < 40 && !m; i++) {
      line = s.proxy.logs().split('\n').find(l => SHAPE.test(l));
      if (line) m = line.match(SHAPE);
      else await sleep(50);
    }
    assert.ok(line, '启动后应至少有一条日志');
    assert.ok(m, '时间戳形状应为 [YYYY-MM-DD HH:MM:SS.mmm]，实际: ' + String(line).slice(0, 48));

    // 语义校验：时间戳按 +05:45 换算后应落在当前时刻附近；若实现是 UTC，差值恒为 5h45m。
    const stampUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) - TZ_OFFSET_MS;
    assert.ok(Math.abs(Date.now() - stampUtc) < 5 * 60 * 1000,
      '时间戳应按子进程本地时区(Asia/Kathmandu)渲染（UTC 形态会偏差 5h45m）');
  } finally { await s.close(); }
});
