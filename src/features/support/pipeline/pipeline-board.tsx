import { Clock, EllipsisVertical, Loader2, Package, Phone, ThumbsDown, ThumbsUp, User } from 'lucide-react'
import { useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PriorityBadge, SlaBadge } from '@/features/support/support-components'
import { slaDeadline, slaRemaining } from '@/features/support/pipeline/pipeline-model'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { BoardStage, PipelineCard } from '@/services/pipelines'

const DRAG_TYPE = 'application/x-alton-ticket'
const PRIORITY_EDGE: Record<string, string> = { URGENT: 'border-l-red-600', HIGH: 'border-l-orange-500', NORMAL: 'border-l-sky-500', LOW: 'border-l-slate-300' }

export function OutcomeIcon({ outcome, className }: { outcome: 'POSITIVE' | 'NEGATIVE' | null; className?: string }) {
  if (outcome === 'POSITIVE') return <ThumbsUp className={cn('size-3.5 text-green-600', className)} aria-label="Positive outcome" />
  if (outcome === 'NEGATIVE') return <ThumbsDown className={cn('size-3.5 text-red-600', className)} aria-label="Negative outcome" />
  return null
}

/**
 * Horizontal Kanban board: open stages, then closed stages. Cards are dragged between stages (or moved with the
 * card menu, which also works on touch screens and with the keyboard); a click opens the ticket page.
 */
export function PipelineBoard({ stages, canMove, saving, onMove }: {
  stages: BoardStage[]; canMove: boolean; saving: Set<string>; onMove: (card: PipelineCard, toStage: BoardStage) => void
}) {
  const [over, setOver] = useState<string | null>(null)
  const firstClosed = stages.findIndex((s) => s.stage_type === 'CLOSED')
  const drop = (e: DragEvent, stage: BoardStage) => {
    e.preventDefault()
    setOver(null)
    if (!canMove) return
    const id = e.dataTransfer.getData(DRAG_TYPE)
    const card = stages.flatMap((s) => s.cards).find((c) => c.id === id)
    if (card && card.stage_id !== stage.id) onMove(card, stage)
  }
  return (
    <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-3 sm:snap-none" data-testid="pipeline-board" role="list" aria-label="Pipeline stages">
      {stages.map((s, i) => (
        <section key={s.id} role="listitem" aria-label={`${s.stage_name}: ${s.count} tickets`} data-testid={`stage-${s.stage_name}`}
          className={cn('flex w-[85vw] shrink-0 snap-start flex-col rounded-lg border bg-surface-muted/40 sm:w-72', i === firstClosed && 'ml-3 sm:ml-4',
            over === s.id && 'ring-2 ring-primary/60', !s.is_active && 'opacity-70')}
          onDragOver={(e) => { if (canMove) { e.preventDefault(); setOver(s.id) } }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null) }}
          onDrop={(e) => drop(e, s)}>
          {/* Same-height label row on every column keeps the stage headers aligned. */}
          <p className="h-6 px-3 pt-2 text-[11px] leading-4 font-semibold tracking-wide text-muted-foreground uppercase" aria-hidden={i !== 0 && i !== firstClosed}>
            {i === 0 ? 'Open' : i === firstClosed ? 'Closed' : ''}</p>
          <header className="border-b px-3 pt-2 pb-2" style={{ borderTop: `3px solid ${s.color}` }} title={s.stage_description ?? undefined}>
            <div className="flex items-center gap-1.5">
              <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{s.stage_name}</h3>
              <OutcomeIcon outcome={s.outcome_type} />
              <span className="rounded-full bg-card px-2 text-xs font-medium tabular-nums" data-testid="stage-count">{s.count}</span>
            </div>
            {s.stage_description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{s.stage_description}</p>}
            {!s.is_active && <p className="mt-0.5 text-xs text-amber-800">Inactive stage</p>}
          </header>
          <div className="flex max-h-[calc(100dvh-20rem)] min-h-24 flex-col gap-2 overflow-y-auto p-2">
            {s.cards.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground" data-testid="stage-empty">No tickets in this stage.</p>}
            {s.cards.map((c) => <TicketCard key={c.id} card={c} stages={stages} canMove={canMove} saving={saving.has(c.id)} onMove={onMove} />)}
            {s.count > s.cards.length && <p className="py-1 text-center text-xs text-muted-foreground">{s.count - s.cards.length} more — narrow the filters or use the list view.</p>}
          </div>
        </section>
      ))}
    </div>
  )
}

function TicketCard({ card: c, stages, canMove, saving, onMove }: {
  card: PipelineCard; stages: BoardStage[]; canMove: boolean; saving: boolean; onMove: (card: PipelineCard, toStage: BoardStage) => void
}) {
  const navigate = useNavigate()
  const sla = slaRemaining(slaDeadline(c))
  const open = () => navigate(`/support/tickets/${c.id}`)
  return (
    <article draggable={canMove && !saving} onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, c.id); e.dataTransfer.effectAllowed = 'move' }}
      onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open() }} tabIndex={0} aria-busy={saving || undefined} data-testid={`card-${c.ticket_number}`}
      className={cn('relative cursor-pointer rounded-md border border-l-4 bg-card p-2.5 text-sm shadow-xs transition hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring',
        PRIORITY_EDGE[c.priority], canMove && !saving && 'active:cursor-grabbing', saving && 'opacity-60')}>
      <div className="flex items-start gap-1">
        <span className="font-mono text-[11px] text-muted-foreground">{c.ticket_number}</span>
        <span className="ml-auto flex items-center gap-1">
          {saving && <Loader2 className="size-3.5 animate-spin text-primary" aria-label="Saving" />}
          <PriorityBadge priority={c.priority} />
          {canMove && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-6" aria-label={`Move ${c.ticket_number}`} disabled={saving} onClick={(e) => e.stopPropagation()}><EllipsisVertical className="size-3.5" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuLabel>Move to</DropdownMenuLabel>
                {stages.filter((s) => s.is_active && s.id !== c.stage_id).map((s) => (
                  <DropdownMenuItem key={s.id} onSelect={() => onMove(c, s)}><span className="size-2 rounded-full" style={{ background: s.color }} />{s.stage_name}<OutcomeIcon outcome={s.outcome_type} className="ml-auto" /></DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 font-medium">{c.subject}</p>
      {(c.customer_name || c.customer_phone || c.customer_email) && (
        <p className="mt-1 truncate text-xs text-muted-foreground">{c.customer_name ?? c.customer_email ?? ''}{c.customer_phone && <span className="ml-1 inline-flex items-center gap-0.5"><Phone className="size-3" />{c.customer_phone}</span>}</p>
      )}
      {c.products && c.products.length > 0 && (
        <p className="mt-1 flex items-start gap-1 text-xs text-muted-foreground"><Package className="mt-0.5 size-3 shrink-0" />
          <span className="line-clamp-2">{c.products.map((p) => `${p.name} (${p.sku})`).join(', ')}</span></p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-0.5"><User className="size-3" />{c.assigned_agent ?? 'Unassigned'}</span>
        <span>{formatDate(c.created_at)}</span>
        <span className="ml-auto inline-flex items-center gap-1"><SlaBadge status={c.sla_status} />
          {sla && <span className={cn('inline-flex items-center gap-0.5', sla.overdue ? 'text-red-700' : '')} data-testid="sla-remaining"><Clock className="size-3" />{sla.text}</span>}</span>
      </div>
    </article>
  )
}
