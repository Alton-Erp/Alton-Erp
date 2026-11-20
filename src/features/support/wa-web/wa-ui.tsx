import { AlertCircle, Check, CheckCheck, Clock3 } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { avatarColor, initials, waTick, waTickLabel } from '@/features/support/wa-web/wa-web-model'
import type { WaStatus } from '@/services/whatsapp'

/** Icon-only button with a tooltip and an accessible name. */
export function IconButton({ label, children, className, tooltip, ...props }: ComponentProps<'button'> & { label: string; tooltip?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} className={cn('inline-flex size-10 shrink-0 items-center justify-center rounded-full text-[#54656F] transition-colors hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-[#008069] disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-5', className)} {...props}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  )
}

export function WaAvatar({ name, seed, size = 49, className }: { name: string | null | undefined; seed: string; size?: number; className?: string }) {
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium text-white', className)}
      style={{ width: size, height: size, backgroundColor: avatarColor(seed), fontSize: Math.round(size * 0.36) }}>{initials(name)}</span>
  )
}

/**
 * Delivery indicator from the stored status only (see waTick). data-testid / data-status match the earlier status
 * badge so existing checks keep working.
 */
export function WaTicks({ direction, status, waMessageId, errorTitle, className }: {
  direction: 'INBOUND' | 'OUTBOUND'; status: WaStatus | string; waMessageId?: string | null; errorTitle?: string | null; className?: string
}) {
  const tick = waTick({ direction, status })
  if (tick === 'NONE') return null
  const label = waTickLabel({ direction, status, wa_message_id: waMessageId, error_title: errorTitle })
  const icon: Record<Exclude<typeof tick, 'NONE'>, ReactNode> = {
    CLOCK: <Clock3 className="size-[14px] text-[#667781]" />,
    SENT: <Check className="size-4 text-[#667781]" />,
    DELIVERED: <CheckCheck className="size-4 text-[#667781]" />,
    READ: <CheckCheck className="size-4 text-[#53BDEB]" />,
    FAILED: <AlertCircle className="size-[15px] text-[#EA0038]" />,
  }
  return (
    <span role="img" aria-label={label} title={label} data-testid="wa-status" data-status={status} data-tick={tick} className={cn('inline-flex items-center', className)}>
      {icon[tick]}
    </span>
  )
}
