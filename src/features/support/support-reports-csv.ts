import type { UnifiedReports } from '../../services/support-unified.ts'

/** Unified report sections as CSV rows (header row first). */
export function reportCsvSections(r: UnifiedReports): Record<string, (string | number | null)[][]> {
  const rt = r.response_times ?? {}
  return {
    'channel-volume': [['Day', 'Phone', 'WhatsApp', 'Email'], ...r.channel_volume.map((d) => [d.day, d.phone, d.whatsapp, d.email]), ['Total', r.channel_totals.phone, r.channel_totals.whatsapp, r.channel_totals.email]],
    calls: [['Inbound calls', 'Answered', 'Missed', 'Answer rate %', 'Missed rate %', 'Average talk (s)'], [r.calls.inbound, r.calls.answered, r.calls.missed, r.calls.answer_rate, r.calls.missed_rate, r.calls.avg_talk_seconds]],
    'response-times': [['Channel', 'Customer turns', 'Answered', 'Average minutes', 'Median minutes', 'Within 1 hour %'],
      ...Object.entries(rt).map(([ch, v]) => [ch, v.turns, v.answered, v.avg_minutes, v.median_minutes, v.within_1h_percent])],
    tickets: [['Created', 'Closed (of created)', 'Closure rate %', 'Resolved in period', 'Open now', 'Reopened'],
      [r.tickets.created, r.tickets.closed, r.tickets.closure_rate, r.tickets.resolved_in_period, r.tickets.open_now, r.tickets.reopened]],
    agents: [['Agent', 'Open tickets', 'Open conversations', 'Resolved', 'Replies'], ...r.agents.map((a) => [a.agent, a.open_tickets, a.open_conversations, a.resolved, a.replies])],
    sla: [['Tickets with SLA', 'First response met', 'First response breached', 'Resolution met', 'Resolution breached', 'Compliance %', 'Escalations'],
      [r.sla.tickets, r.sla.first_response_met, r.sla.first_response_breached, r.sla.resolution_met, r.sla.resolution_breached, r.sla.compliance_percent, r.sla.escalations]],
    satisfaction: [['Responses', 'Average', ...[1, 2, 3, 4, 5].map((x) => `${x} stars`)], [r.csat.responses, r.csat.average, ...[1, 2, 3, 4, 5].map((x) => r.csat.distribution?.[String(x)] ?? 0)]],
  }
}
