import type { MetadataRoute } from 'next'
import { BRAND_NAME, BRAND_SHORT_NAME, BRAND_DESCRIPTION } from '@/lib/brand'

// Web app manifest: what the browser and the phone show when the app is
// installed or added to the home screen ("Add to Home screen" uses
// `short_name` under the icon and `name` on the install prompt).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND_NAME,
    short_name: BRAND_SHORT_NAME,
    description: BRAND_DESCRIPTION,
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#020617',
    theme_color: '#020617',
    icons: [
      { src: '/pwa-icon/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa-icon/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa-icon/512', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
