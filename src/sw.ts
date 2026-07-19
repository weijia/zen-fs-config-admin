/* eslint-disable no-restricted-globals */

// Skip waiting message handler
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    (self as any).skipWaiting()
  }
})

// Import workbox
const { precacheAndRoute, cleanupOutdatedCaches } = await import('workbox-precaching')

// Precache
precacheAndRoute(self.__WB_MANIFEST)

// Clean up old caches
cleanupOutdatedCaches()