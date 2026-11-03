import { Bell, BellOff, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NOTIFICATIONS_CHANGED, SEVERITY_DOT } from '@/features/admin/notification-labels'
import { resolveNotificationLink } from '@/features/admin/notification-links'
import { formatDateTime } from '@/lib/format'
import { fetchNotifications, fetchUnreadCount, markNotificationsRead, syncNotifications, type NotificationRow } from '@/services/admin'

/**
 * Unread badge and latest notifications. Refreshed from the database every 60
 * seconds (Supabase Realtime is not configured); alerts are turned into
 * notifications at most every 2 minutes per user, deduplicated on the server.
 */
export function NotificationsMenu() {
  const navigate = useNavigate()
  const [count, setCount] = useState<number | null>(null)
  const [items, setItems] = useState<NotificationRow[] | null>(null)
  const [loading, setLoading] = useState(false)

  const refreshCount = useCallback(() => { fetchUnreadCount().then(setCount, () => undefined) }, [])

  useEffect(() => {
    let alive = true
    void syncNotifications().catch(() => undefined).then(() => alive && refreshCount())
    const timer = setInterval(() => { void syncNotifications().catch(() => undefined).then(() => alive && refreshCount()) }, 60_000)
    const onChange = () => refreshCount()
    window.addEventListener(NOTIFICATIONS_CHANGED, onChange)
    return () => { alive = false; clearInterval(timer); window.removeEventListener(NOTIFICATIONS_CHANGED, onChange) }
  }, [refreshCount])

  const load = () => {
    setLoading(true)
    fetchNotifications({ unreadOnly: false, type: null, severity: null, from: null, to: null }, 0, 6)
      .then((r) => setItems(r.rows), () => setItems([])).finally(() => setLoading(false))
  }

  const open = async (n: NotificationRow) => {
    if (!n.read_at) await markNotificationsRead([n.id]).catch(() => undefined)
    refreshCount()
    // Links to modules that are no longer in the ERP open the notification centre instead.
    navigate(resolveNotificationLink(n.link) ?? '/notifications')
  }

  return (
    <DropdownMenu onOpenChange={(o) => o && load()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={count ? `Notifications (${count} unread)` : 'Notifications'} className="relative">
          <Bell />
          {count ? <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-shortage px-1 text-[10px] leading-4 font-semibold text-white">{count > 99 ? '99+' : count}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96">
        <DropdownMenuLabel className="flex items-center justify-between">Notifications {count ? <span className="text-xs font-normal text-muted-foreground">{count} unread</span> : null}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loading && !items ? <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin" /></div> : !items?.length ? (
          <div className="flex flex-col items-center px-4 py-6 text-center">
            <BellOff aria-hidden className="mb-2 size-5 text-muted-foreground" />
            <p className="text-sm font-medium">No notifications</p>
          </div>
        ) : items.map((n) => (
          <DropdownMenuItem key={n.id} onSelect={() => void open(n)} className="flex items-start gap-2 py-2">
            <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${n.read_at ? 'bg-transparent' : SEVERITY_DOT[n.severity]}`} />
            <span className="min-w-0">
              <span className={`block truncate text-sm ${n.read_at ? '' : 'font-medium'}`}>{n.title}</span>
              <span className="line-clamp-2 block text-xs text-muted-foreground">{n.message}</span>
              <span className="block text-[11px] text-muted-foreground">{formatDateTime(n.created_at)}</span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/notifications')} className="justify-center text-primary">View notification centre</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
