import { Camera, CameraOff, Loader2, ScanLine } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { acceptScan, cameraScanSupport } from '@/features/admin/barcode'

interface DetectedBarcode { rawValue: string }
interface BarcodeDetectorLike { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike

/**
 * Scan field: works with keyboard-wedge (USB/Bluetooth) scanners and manual
 * typing (Enter submits), and with the device camera where supported. A scan
 * only reports the code; nothing is posted until the user confirms elsewhere.
 */
export function ScanInput({ id = 'scan-code', label = 'Scan or type a code', onScan, disabled, autoFocus = true }: {
  id?: string
  label?: string
  onScan: (code: string) => void
  disabled?: boolean
  autoFocus?: boolean
}) {
  const [text, setText] = useState('')
  const [camera, setCamera] = useState<'off' | 'starting' | 'on'>('off')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState(false)
  const last = useRef<{ code: string; at: number } | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const support = cameraScanSupport()

  const emit = (raw: string) => {
    const code = raw.trim()
    if (!code) return
    const now = Date.now()
    if (!acceptScan(last.current, code, now)) {
      setDuplicate(true)
      return
    }
    setDuplicate(false)
    last.current = { code, at: now }
    onScan(code)
  }

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setCamera('off')
  }

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), [])

  useEffect(() => {
    if (camera !== 'on') return
    const Ctor = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector
    const detector = new Ctor()
    let stopped = false
    const tick = async () => {
      if (stopped || !videoRef.current) return
      try {
        if (videoRef.current.readyState >= 2) {
          const found = await detector.detect(videoRef.current)
          if (found[0]?.rawValue) emit(found[0].rawValue)
        }
      } catch {
        // a frame that cannot be analysed is skipped
      }
      if (!stopped) setTimeout(() => void tick(), 300)
    }
    void tick()
    return () => { stopped = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera])

  const startCamera = async () => {
    setCameraError(null)
    setCamera('starting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCamera('on')
    } catch (e) {
      const name = (e as { name?: string }).name
      setCameraError(name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in the browser settings, or type the code.'
        : name === 'NotFoundError' ? 'No camera was found on this device.'
          : name === 'NotReadableError' ? 'The camera is in use by another application.'
            : 'The camera could not be started.')
      stopCamera()
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <ScanLine aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input id={id} className="pl-9 font-mono" autoComplete="off" autoFocus={autoFocus} disabled={disabled} value={text} placeholder="Barcode, SKU, lot, location or QR link"
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); emit(text); setText('') } }} />
        </div>
        <Button type="button" variant="outline" disabled={disabled || !text.trim()} onClick={() => { emit(text); setText('') }}>Look up</Button>
        {support.supported && (camera === 'off'
          ? <Button type="button" variant="outline" disabled={disabled} onClick={() => void startCamera()}><Camera /> Use camera</Button>
          : <Button type="button" variant="outline" onClick={stopCamera}>{camera === 'starting' ? <Loader2 className="animate-spin" /> : <CameraOff />} Stop camera</Button>)}
      </div>
      {duplicate && <p className="text-xs text-amber-700" role="status">Same code scanned again within a moment — ignored. Scan again after a second, or change the quantity, to count another unit.</p>}
      {!support.supported && <p className="text-xs text-muted-foreground">Camera scanning unavailable: {support.reason}</p>}
      {cameraError && <p role="alert" className="text-xs text-red-800">{cameraError}</p>}
      <video ref={videoRef} muted playsInline className={camera === 'off' ? 'hidden' : 'max-h-64 w-full max-w-md rounded-lg border bg-black'} aria-label="Camera preview" />
    </div>
  )
}
