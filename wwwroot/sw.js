const CACHE = 'seamless-shell-v5';
const SHELL = ['/', '/index.html', '/styles.css?v=5', '/app.js?v=5', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/manifest.webmanifest'];
const SHELL_PATHS = new Set(SHELL.map(path => new URL(path, self.location.origin).pathname));
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))])));
function openDrafts() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('seamless-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith((async () => {
      try {
        const form = await event.request.formData();
        const db = await openDrafts();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').put({title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', files: form.getAll('files').filter(file => file instanceof File)}, 'incoming');
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
        db.close();
        return Response.redirect('/?shared=1', 303);
      } catch { return Response.redirect('/', 303); }
    })());
    return;
  }
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/hubs/') || url.pathname === '/share') return;
  if (!SHELL_PATHS.has(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request)));
});
