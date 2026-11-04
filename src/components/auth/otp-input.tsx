import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react'

import { applyOtpBackspace, applyOtpInput, OTP_LENGTH } from '@/features/auth/password-recovery'
import { cn } from '@/lib/utils'

interface OtpInputProps {
  digits: string[]
  onChange: (digits: string[]) => void
  disabled?: boolean
  invalid?: boolean
  /** Changing this value focuses the first empty box (after a failed check or a new code). */
  focusSignal?: number
  describedBy?: string
}

/** Six one-digit boxes: digits only, focus moves on, Backspace goes back, a pasted code fills every box. */
export function OtpInput({ digits, onChange, disabled, invalid, focusSignal = 0, describedBy }: OtpInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const focus = (i: number) => {
    const el = refs.current[Math.max(0, Math.min(i, OTP_LENGTH - 1))]
    el?.focus()
    el?.select()
  }

  useEffect(() => {
    if (disabled) return
    const firstEmpty = digits.findIndex((d) => !d)
    focus(firstEmpty === -1 ? OTP_LENGTH - 1 : firstEmpty)
    // Only when asked to (focusSignal) or when the boxes become editable again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal, disabled])

  const put = (index: number, text: string) => {
    const r = applyOtpInput(digits, index, text)
    onChange(r.digits)
    focus(r.focus)
  }

  const onKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault()
      const r = applyOtpBackspace(digits, index)
      onChange(r.digits)
      focus(r.focus)
    } else if (e.key === 'Delete') {
      e.preventDefault()
      const next = [...digits]
      next[index] = ''
      onChange(next)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      focus(index - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      focus(index + 1)
    } else if (e.key.length === 1 && !/\d/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      // Letters and symbols are ignored.
      e.preventDefault()
    }
  }

  const onPaste = (index: number, e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    put(index, e.clipboardData.getData('text'))
  }

  return (
    <div className="flex justify-between gap-1.5 sm:gap-2" role="group" aria-label="6-digit code" aria-describedby={describedBy}>
      {Array.from({ length: OTP_LENGTH }, (_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el }}
          id={`otp-${i}`}
          data-otp-index={i}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          // Room for a whole code typed or auto-filled into one box; extra digits move on.
          maxLength={OTP_LENGTH}
          aria-label={`Digit ${i + 1} of ${OTP_LENGTH}`}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          value={digits[i] ?? ''}
          onChange={(e) => {
            const typed = e.target.value.replace(digits[i] ?? '', '') || e.target.value
            put(i, typed)
          }}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={(e) => onPaste(i, e)}
          onFocus={(e) => e.target.select()}
          className={cn(
            'h-12 w-full min-w-0 max-w-12 rounded-lg border bg-background text-center text-lg font-semibold tabular-nums text-foreground shadow-xs outline-none transition-colors',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60',
            invalid ? 'border-red-400' : 'border-input',
          )}
        />
      ))}
    </div>
  )
}
