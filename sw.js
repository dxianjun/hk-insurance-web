/**
 * sw.js — 香港保险对比 Web 应用 Service Worker
 *
 * 缓存策略：
 *   /data/*.json   → Network First（优先网络，失败时用缓存）
 *   /index.html    → Network First（确保最新版本）
 *   静态资源        → Cache First（CSS/JS内联，无需额外处理）
 *
 * 生命周期：install → activate → fetch
 */
const CACHE_NAME = 'hk-insurance-v1';
const DATA_CACHE = 'hk-insurance-data-v1';
const MAX_DATA_AGE = 30 * 60 * 1000; // 数据缓存30分钟过期

// ── Install：预缓存核心资源 ─────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] 安装中…');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        '/',
        '/index.html',
      ]);
    }).then(() => {
      console.log('[SW] 预缓存完成');
      return self.skipWaiting(); // 立即激活
    })
  );
});

// ── Activate：清理旧缓存 ─────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] 激活');
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
      );
    }).then(() => {
      return self.clients.claim(); // 接管所有页面
    })
  );
});

// ── Fetch：智能路由 ──────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 跳过非 GET 请求
  if (request.method !== 'GET') return;

  // 仅处理同源请求
  if (url.origin !== self.location.origin) return;

  // ── 策略 1：数据文件 → Network First ──
  if (url.pathname.startsWith('/data/')) {
    event.respondWith(networkFirst(request, DATA_CACHE, MAX_DATA_AGE));
    return;
  }

  // ── 策略 2：HTML → Network First ──
  if (request.destination === 'document' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(networkFirst(request, CACHE_NAME));
    return;
  }

  // ── 默认：Network First ──
  event.respondWith(networkFirst(request, CACHE_NAME));
});

// ── 策略函数 ─────────────────────────────────────────

/**
 * Network First：先尝试网络，失败时用缓存
 * @param {Request} request
 * @param {string} cacheName
 * @param {number} maxAge - 缓存最大有效期（毫秒），超过后视为过期
 */
async function networkFirst(request, cacheName, maxAge) {
  try {
    const networkResponse = await fetch(request);

    // 仅缓存成功的响应
    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      // 克隆响应（响应流只能读一次）
      cache.put(request, networkResponse.clone());

      // 存储缓存时间
      if (maxAge) {
        const metaCache = await caches.open(cacheName + '-meta');
        metaCache.put(
          new Request(request.url + '?meta=timestamp'),
          new Response(JSON.stringify({ cachedAt: Date.now() }))
        );
      }
    }

    return networkResponse;
  } catch (error) {
    // 网络失败 → 检查缓存
    const cachedResponse = await caches.match(request);

    if (cachedResponse) {
      // 检查是否过期
      if (maxAge) {
        const metaCache = await caches.open(cacheName + '-meta');
        const metaResponse = await metaCache.match(
          new Request(request.url + '?meta=timestamp')
        );
        if (metaResponse) {
          const { cachedAt } = await metaResponse.json();
          if (Date.now() - cachedAt > maxAge) {
            console.warn('[SW] 缓存已过期:', request.url);
            // 仍返回过期缓存（离线时总比没有好）
          }
        }
      }
      console.log('[SW] 使用缓存:', request.url);
      return cachedResponse;
    }

    // 无缓存 → 返回离线提示页
    return new Response(
      JSON.stringify({
        error: 'offline',
        message: '当前处于离线状态，且无可用缓存数据',
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// ── 消息处理 ─────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }

  // 前端请求刷新数据缓存
  if (event.data === 'clearDataCache') {
    caches.delete(DATA_CACHE).then(() => {
      console.log('[SW] 数据缓存已清除');
    });
  }

  // 获取缓存状态
  if (event.data === 'getCacheStatus') {
    Promise.all([
      caches.has(CACHE_NAME),
      caches.has(DATA_CACHE),
    ]).then(([hasCore, hasData]) => {
      event.ports[0].postMessage({ hasCore, hasData });
    });
  }
});
