import { usePermissions } from '@/auth/use-permissions'

/** The signed-in user's Support Centre permissions (the database enforces the same rules). */
export function useSupportPermissions() {
  const { has } = usePermissions()
  return {
    view: has('support.view'), manageTickets: has('support.manage_tickets'), assign: has('support.assign'), reply: has('support.reply'),
    integrations: has('support.manage_integrations'), reports: has('support.view_reports'), settings: has('support.manage_settings'),
  }
}
