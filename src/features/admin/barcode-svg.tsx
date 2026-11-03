import qrcode from 'qrcode-generator'

import { code128Widths, isCode128B } from '@/features/admin/barcode'

/** Code 128 barcode as an SVG (quiet zones included), with the text below. */
export function Code128Svg({ value, height = 48, moduleWidth = 1.6, showText = true, className }: {
  value: string
  height?: number
  moduleWidth?: number
  showText?: boolean
  className?: string
}) {
  if (!isCode128B(value)) return <span className="text-xs text-shortage">Cannot encode "{value}" as Code 128</span>
  const widths = code128Widths(value)
  const quiet = 10
  const total = widths.reduce((s, w) => s + w, 0) + quiet * 2
  let x = quiet
  const bars: { x: number; w: number }[] = []
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push({ x, w })
    x += w
  })
  const textH = showText ? 14 : 0
  return (
    <svg role="img" aria-label={`Barcode ${value}`} className={className} width={total * moduleWidth} height={height + textH}
      viewBox={`0 0 ${total} ${height + textH}`} preserveAspectRatio="none" shapeRendering="crispEdges">
      <rect width={total} height={height + textH} fill="#fff" />
      {bars.map((b) => <rect key={b.x} x={b.x} y={0} width={b.w} height={height} fill="#000" />)}
      {showText && <text x={total / 2} y={height + 11} textAnchor="middle" fontSize="10" fontFamily="monospace" fill="#000">{value}</text>}
    </svg>
  )
}

/** QR code (error correction M) as an SVG path. */
export function QrSvg({ value, size = 96, className }: { value: string; size?: number; className?: string }) {
  const qr = qrcode(0, 'M')
  qr.addData(value)
  qr.make()
  const n = qr.getModuleCount()
  const quiet = 2
  let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`
  return (
    <svg role="img" aria-label="QR code" className={className} width={size} height={size} viewBox={`0 0 ${n + quiet * 2} ${n + quiet * 2}`} shapeRendering="crispEdges">
      <rect width={n + quiet * 2} height={n + quiet * 2} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}
