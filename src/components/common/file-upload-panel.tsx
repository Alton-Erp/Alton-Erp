import { FileSpreadsheet, UploadCloud, X } from 'lucide-react'
import { useId, useRef, useState, type DragEvent } from 'react'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Button } from '@/components/ui/button'
import { formatFileSize } from '@/lib/format'
import { cn } from '@/lib/utils'

interface FileUploadPanelProps {
  /** Lower-case extensions including the dot, e.g. ['.xlsx', '.csv']. */
  accept: string[]
  maxSizeMb?: number
  file: File | null
  onFileChange: (file: File | null) => void
  className?: string
}

/** Drag-and-drop file picker with client-side type/size validation. Does not upload anywhere. */
export function FileUploadPanel({ accept, maxSizeMb = 10, file, onFileChange, className }: FileUploadPanelProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const selectFile = (candidate: File | undefined) => {
    if (!candidate) return
    const ext = candidate.name.slice(candidate.name.lastIndexOf('.')).toLowerCase()
    if (!accept.includes(ext)) {
      setError(`“${candidate.name}” is not a supported file. Use ${accept.join(', ')}.`)
      return
    }
    if (candidate.size > maxSizeMb * 1024 * 1024) {
      setError(`File is larger than ${maxSizeMb} MB.`)
      return
    }
    setError(null)
    onFileChange(candidate)
  }

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    setDragging(false)
    selectFile(e.dataTransfer.files[0])
  }

  if (file) {
    return (
      <div className={cn('flex items-center gap-3 rounded-lg border bg-background p-4', className)}>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-green-50 text-available">
          <FileSpreadsheet aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.name}</p>
          <p className="text-xs text-muted-foreground">{formatFileSize(file.size)} · Ready for analysis</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => setConfirmRemove(true)} aria-label="Remove file">
          <X />
        </Button>
        <ConfirmDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title="Remove this file?"
          description={`“${file.name}” will be cleared from the analyzer. You can select it again at any time.`}
          confirmLabel="Remove file"
          destructive
          onConfirm={() => {
            onFileChange(null)
            if (inputRef.current) inputRef.current.value = ''
          }}
        />
      </div>
    )
  }

  return (
    <div className={className}>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors',
          dragging ? 'border-primary bg-accent' : 'border-gray-300 bg-surface-muted/50 hover:border-primary/60 hover:bg-accent/50',
        )}
      >
        <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-background text-primary shadow-xs">
          <UploadCloud aria-hidden className="size-5" />
        </span>
        <span className="text-sm font-medium">
          <span className="text-primary">Click to choose a file</span> or drag it here
        </span>
        <span className="mt-1 text-xs text-muted-foreground">
          {accept.join(', ')} · up to {maxSizeMb} MB
        </span>
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept.join(',')}
        className="sr-only"
        onChange={(e) => selectFile(e.target.files?.[0])}
      />
      {error && (
        <p role="alert" className="mt-2 text-sm text-shortage">
          {error}
        </p>
      )}
    </div>
  )
}
