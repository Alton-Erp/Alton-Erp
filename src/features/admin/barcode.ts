/**
 * Code 128 (code set B) encoder producing bar widths, plus helpers for the
 * internal QR payload and scan handling. Pure functions (unit-tested).
 */

// Bar/space widths of the 107 Code 128 symbols (values 0-105, 106 = stop).
export const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
] as const

const START_B = 104
const STOP = 106

/** Code set B covers printable ASCII (space to ~). */
export const isCode128B = (text: string) => text.length > 0 && text.length <= 80 && /^[\x20-\x7E]+$/.test(text)

/** Symbol values including start and checksum (stop excluded). */
export function code128Values(text: string): number[] {
  if (!isCode128B(text)) throw new Error('Barcode text must be 1-80 printable ASCII characters.')
  const values = [START_B, ...[...text].map((ch) => ch.charCodeAt(0) - 32)]
  const checksum = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103
  return [...values, checksum]
}

/** Alternating bar/space module widths, starting with a bar, ending with the stop pattern. */
export function code128Widths(text: string): number[] {
  return [...code128Values(text), STOP].flatMap((v) => [...CODE128_PATTERNS[v]].map(Number))
}

// ---------------------------------------------------------------------------
// Internal QR payload: an authenticated link, never data or credentials.
// ---------------------------------------------------------------------------
export type ScanKind = 'P' | 'B' | 'L' | 'W' | 'F'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function scanPayload(origin: string, kind: ScanKind, id: string): string {
  if (!UUID.test(id)) throw new Error('Invalid record id')
  return `${origin.replace(/\/+$/, '')}/scan?c=${kind}-${id.toLowerCase()}`
}

export function parseScanPayload(code: string): { kind: ScanKind; id: string } | null {
  const m = /(?:^|[?&]c=)([PBLWF])-([0-9a-fA-F-]{36})$/.exec(code.trim())
  return m && UUID.test(m[2]) ? { kind: m[1] as ScanKind, id: m[2].toLowerCase() } : null
}

/**
 * Keyboard-wedge and camera scanners can report the same code several times in
 * quick succession; repeats within the window are ignored (an operator scans
 * again after the window, or edits the quantity, to count another unit).
 */
export function acceptScan(previous: { code: string; at: number } | null, code: string, now: number, windowMs = 1500): boolean {
  const clean = code.trim()
  if (!clean) return false
  return !(previous && previous.code === clean && now - previous.at < windowMs)
}

// ---------------------------------------------------------------------------
// File signature check before upload (the server cannot inspect content).
// ---------------------------------------------------------------------------
const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v)

export function fileSignatureMatches(extension: string, head: Uint8Array): boolean {
  switch (extension.toLowerCase()) {
    case 'pdf': return startsWith(head, [0x25, 0x50, 0x44, 0x46])
    case 'png': return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'jpg':
    case 'jpeg': return startsWith(head, [0xff, 0xd8, 0xff])
    case 'webp': return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)
    case 'xlsx':
    case 'docx': return startsWith(head, [0x50, 0x4b, 0x03, 0x04])
    case 'csv':
    case 'txt': return head.length > 0 && !head.includes(0)
    default: return false
  }
}

export const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', csv: 'text/csv', txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export const extensionOf = (name: string) => (/\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1] ?? '').toLowerCase()

/** Camera scanning needs the browser's BarcodeDetector API, a camera and a secure (https) page. */
export function cameraScanSupport(): { supported: boolean; reason: string | null } {
  if (typeof window === 'undefined') return { supported: false, reason: 'Not available here.' }
  if (!window.isSecureContext) return { supported: false, reason: 'Camera scanning needs the app to be opened over https.' }
  if (!('BarcodeDetector' in window)) {
    return { supported: false, reason: 'This browser has no built-in barcode detector (e.g. Firefox, Safari, Chrome on Windows/Linux). Use a USB/Bluetooth scanner or type the code.' }
  }
  if (!navigator.mediaDevices?.getUserMedia) return { supported: false, reason: 'This browser does not allow camera access.' }
  return { supported: true, reason: null }
}
