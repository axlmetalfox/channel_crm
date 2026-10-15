import { ImageResponse } from 'next/og'

// Home-screen / install icons for the web app manifest. Same mark as the
// favicon (src/app/icon.tsx) at the sizes Android and desktop installs
// ask for. Full-bleed background so the maskable variant is safe.
const SIZES = new Set([192, 512])

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ size: string }> },
) {
  const { size: raw } = await params
  const size = Number(raw)
  if (!SIZES.has(size)) return new Response('Not found', { status: 404 })

  const glyph = Math.round(size * 0.52)
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#7c3aed',
        }}
      >
        <svg
          width={glyph}
          height={glyph}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
    ),
    { width: size, height: size },
  )
}
