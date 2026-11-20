import { Ban, Check, ChevronDown, Copy, Download, Forward, Info, Loader2, Reply, RotateCcw, SmilePlus, SquareCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { openAttachment } from '@/features/support/wa-web/media-urls'
import { MessageMedia } from '@/features/support/wa-web/message-media'
import { WaTicks } from '@/features/support/wa-web/wa-ui'
import { bubbleTime, highlight, isUnsupported, reactionEmoji, visibleBody } from '@/features/support/wa-web/wa-web-model'
import { cn } from '@/lib/utils'
import type { WaMessage } from '@/services/whatsapp'

/** Actions the Cloud API connector does not support: offered, but disabled with the reason (nothing pretends to work). */
const NOT_SUPPORTED = {
  react: 'Sending reactions is not supported by the ERP’s WhatsApp connector yet.',
  forward: 'Forwarding is not supported: each customer needs their own conversation (and an approved template outside the 24-hour window).',
  delete: 'Messages cannot be deleted: the Cloud API cannot unsend a message and the support history is kept.',
}

export interface BubbleProps {
  m: WaMessage
  customerName: string
  quoted: WaMessage | null
  timezone?: string
  search: string
  isHit: boolean
  selecting: boolean
  selected: boolean
  canReply: boolean
  retry: { allowed: boolean; busy: boolean; onRetry: () => void }
  onReply: () => void
  onSelect: () => void
  onInfo: () => void
  onCopy: () => void
  onJumpTo: (waMessageId: string) => void
  onChanged: () => void
}

function Text({ text, term }: { text: string; term: string }) {
  return <>{highlight(text, term).map((p, i) => (p.hit ? <mark key={i} className="rounded-sm bg-[#FFD279] text-inherit">{p.text}</mark> : <span key={i}>{p.text}</span>))}</>
}

export function MessageBubble(p: BubbleProps) {
  const { m } = p
  const inbound = m.direction === 'INBOUND'
  const [menu, setMenu] = useState(false)
  const reaction = reactionEmoji(m)
  const time = bubbleTime(m.at, p.timezone)

  // Inbound reactions: Meta's target message id is not stored, so they are a small line of their own.
  if (reaction !== null) {
    return (
      <li className="flex justify-start px-[5%] py-0.5" data-testid={`wa-${m.id}`} data-kind="reaction">
        <span className="rounded-full bg-white px-3 py-1 text-xs text-[#667781] shadow-sm">
          {reaction ? <>{p.customerName} reacted <span className="text-base">{reaction}</span></> : `${p.customerName} removed a reaction`} · {time}</span>
      </li>
    )
  }

  const body = visibleBody(m)
  const unsupported = isUnsupported(m)
  const pick = () => { if (p.selecting) p.onSelect() }
  return (
    <li className={cn('group flex px-[3%] py-0.5 md:px-[5%]', inbound ? 'justify-start' : 'justify-end', p.selecting && 'cursor-pointer', p.selected && 'bg-[#00A884]/10')}
      data-testid={`wa-${m.id}`} data-direction={m.direction} onClick={pick} id={m.wa_message_id ? `wa-msg-${m.wa_message_id}` : undefined}>
      {p.selecting && (
        <span role="checkbox" aria-checked={p.selected} aria-label="Select message" tabIndex={0} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); p.onSelect() } }}
          className={cn('mr-3 mt-2 flex size-[18px] shrink-0 items-center justify-center rounded-sm border-2', p.selected ? 'border-[#00A884] bg-[#00A884] text-white' : 'border-[#8696A0] bg-white')}>
          {p.selected && <Check className="size-3" strokeWidth={4} />}</span>
      )}
      <div className={cn('relative max-w-[85%] rounded-lg px-2 pb-1.5 pt-1.5 text-[14.2px] leading-[19px] text-[#111B21] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] md:max-w-[65%]',
        inbound ? 'rounded-tl-none bg-white' : 'rounded-tr-none bg-[#D9FDD3]', p.isHit && 'ring-2 ring-[#FFD279]')}>
        {/* Bubble tail */}
        <span aria-hidden className={cn('absolute top-0 size-2', inbound ? '-left-2 bg-white [clip-path:polygon(100%_0,0_0,100%_100%)]' : '-right-2 bg-[#D9FDD3] [clip-path:polygon(0_0,100%_0,0_100%)]')} />
        {!p.selecting && (
          <DropdownMenu open={menu} onOpenChange={setMenu}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Message options" className={cn('absolute right-1 top-1 z-10 rounded-full p-0.5 text-[#8696A0] opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100',
                inbound ? 'bg-white/90' : 'bg-[#D9FDD3]/90')}><ChevronDown className="size-5" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={inbound ? 'start' : 'end'} className="w-56">
              <DropdownMenuItem disabled={!p.canReply} onSelect={p.onReply}><Reply />Reply</DropdownMenuItem>
              <DropdownMenuItem disabled title={NOT_SUPPORTED.react}><SmilePlus />React<span className="ml-auto text-[10px]">not supported</span></DropdownMenuItem>
              <DropdownMenuItem onSelect={p.onCopy}><Copy />Copy</DropdownMenuItem>
              <DropdownMenuItem disabled title={NOT_SUPPORTED.forward}><Forward />Forward<span className="ml-auto text-[10px]">not supported</span></DropdownMenuItem>
              <DropdownMenuItem onSelect={p.onSelect}><SquareCheck />Select</DropdownMenuItem>
              {m.attachment?.storage_path && !m.attachment.restricted && <DropdownMenuItem onSelect={() => void openAttachment(m.attachment!.storage_path!)}><Download />Download</DropdownMenuItem>}
              <DropdownMenuItem onSelect={p.onInfo}><Info />Message info</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled title={NOT_SUPPORTED.delete}><Trash2 />Delete<span className="ml-auto text-[10px]">not supported</span></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {!inbound && m.author && <p className="pr-6 text-[12.8px] font-medium text-[#008069]">{m.author}</p>}
        {m.template_name && <p className="mb-0.5 pr-6 text-[11px] uppercase tracking-wide text-[#667781]">Template · {m.template_name}</p>}
        {m.context_wa_message_id && (
          <button type="button" onClick={(e) => { e.stopPropagation(); p.onJumpTo(m.context_wa_message_id!) }} data-testid="wa-quote"
            className={cn('mb-1 block w-full rounded-md border-l-4 px-2 py-1 text-left text-[13px]', inbound ? 'border-[#06CF9C] bg-[#F5F6F6]' : 'border-[#06CF9C] bg-[#D1F4CC]')}>
            <span className="block text-xs font-medium text-[#06CF9C]">{p.quoted ? (p.quoted.direction === 'INBOUND' ? p.customerName : p.quoted.author ?? 'You') : 'Earlier message'}</span>
            <span className="line-clamp-2 text-[#667781]">{p.quoted ? p.quoted.body : 'The quoted message is not in this conversation.'}</span>
          </button>
        )}
        <MessageMedia m={m} onChanged={p.onChanged} />
        {unsupported ? (
          <p className="flex items-center gap-1.5 pr-14 italic text-[#667781]"><Ban className="size-4" />This message type cannot be shown in the ERP.</p>
        ) : body ? (
          <p className="whitespace-pre-wrap break-words pr-14"><Text text={body} term={p.search} /></p>
        ) : null}
        <span className={cn('float-right -mb-1 ml-2 mt-1 flex items-center gap-1 text-[11px] leading-[15px] text-[#667781]', !body && !unsupported && 'mt-0')}>
          <time dateTime={m.at}>{time}</time>
          <WaTicks direction={m.direction} status={m.status} waMessageId={m.wa_message_id} errorTitle={m.error_title} />
        </span>
        <span className="clear-both block" />
        {m.status === 'FAILED' && (
          <div role="alert" className="mt-1 rounded-md bg-[#FFE7EA] px-2 py-1 text-xs text-[#B1002A]">
            {m.error_title ?? 'Failed'}{m.error_code ? ` (${m.error_code})` : ''}{m.error_detail ? `: ${m.error_detail}` : ''}
            {p.retry.allowed && (
              <button type="button" disabled={p.retry.busy} onClick={(e) => { e.stopPropagation(); p.retry.onRetry() }} data-testid="wa-retry"
                className="ml-2 inline-flex items-center gap-1 font-medium text-[#008069] hover:underline disabled:opacity-50">
                {p.retry.busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}Send again</button>
            )}
          </div>
        )}
        {m.status === 'PENDING' && m.error_title === 'Not confirmed' && (
          <p className="mt-1 text-xs text-amber-800">Meta did not confirm this request; check WhatsApp Manager before sending it again.</p>
        )}
      </div>
    </li>
  )
}
