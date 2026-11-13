// whatsapp-send-template: approved templates only (synchronised from Meta; status APPROVED; every placeholder
// filled), the only messages allowed outside the 24-hour window or to start a conversation. Rules in
// _shared/whatsapp/send.ts and support_whatsapp_send_prepare; unit-tested in tests/unit/whatsapp-functions.test.ts.

import { handleSend, type SendDeps } from '../_shared/whatsapp/send.ts'

export type Deps = SendDeps
export const handle = (req: Request, deps: Deps) => handleSend(req, deps, ['TEMPLATE'], 'whatsapp-send-template')
