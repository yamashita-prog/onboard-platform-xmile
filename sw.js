// ═══════════════════════════════════════════════
// Onboard — Service Worker (Push通知 + バックグラウンドポーリング)
// ═══════════════════════════════════════════════

const SW_VERSION = 'onboard-sw-v1';

// ── インストール ──
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── プッシュ通知受信 ──
self.addEventListener('push', event => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); } catch { data = { title: 'Onboard', body: event.data.text() }; }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Onboard', {
      body: data.body || '',
      icon: data.icon || '/favicon.ico',
      badge: data.badge || '/favicon.ico',
      tag: data.tag || 'onboard-notif',
      data: data.url || '/',
      requireInteraction: false,
    })
  );
});

// ── 通知クリック → アプリを開く ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});

// ── メインスレッドからのメッセージ受信（ローカル通知送信指示） ──
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};
  if (type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon || '',
      tag: payload.tag || 'onboard-local',
      data: payload.url || '/',
      requireInteraction: false,
    });
  }
});

// ── バックグラウンドポーリング（Periodic Background Sync 非対応ブラウザ用フォールバック済み） ──
// ※ Periodic Background Sync はChrome限定 + HTTPS必須のため、
//   メインスレッド側の setInterval と組み合わせて動作します。
self.addEventListener('periodicsync', event => {
  if (event.tag === 'mission-poll') {
    event.waitUntil(pollMissions());
  }
});

async function pollMissions() {
  // Service Worker内では直接DBアクセス
  // SUPABASE_URL / KEY はメインスレッドから postMessage で渡されキャッシュされる
  const cache = await caches.open(SW_VERSION);
  const configRes = await cache.match('/__sw_config__');
  if (!configRes) return;
  const { supabaseUrl, supabaseKey, candidateId } = await configRes.json();
  if (!supabaseUrl || !candidateId) return;

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/missions?candidate_id=eq.${candidateId}&done=eq.true&select=mission_id,xp`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    if (!res.ok) return;
    const rows = await res.json();
    const prevRes = await cache.match('/__sw_prev_missions__');
    const prev = prevRes ? await prevRes.json() : [];

    const prevIds = new Set(prev.map(r => String(r.mission_id)));
    const newlyDone = rows.filter(r => !prevIds.has(String(r.mission_id)));

    if (newlyDone.length > 0) {
      await self.registration.showNotification('🎯 Onboard — ミッション完了！', {
        body: `${newlyDone.length}件のミッションが完了しました！アプリで確認しましょう`,
        tag: 'mission-done',
        requireInteraction: false,
      });
    }
    await cache.put('/__sw_prev_missions__', new Response(JSON.stringify(rows)));
  } catch (e) {
    console.warn('[SW] pollMissions error', e);
  }
}
