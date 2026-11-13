// whatsapp-send-message: free-form text, image or document replies inside the 24-hour customer service window
// (enforced by the database). Rules in _shared/whatsapp/send.ts; unit-tested in tests/unit/whatsapp-functions.test.ts.

import { handleSend, type SendDeps } from '../_shared/whatsapp/send.ts'

export type Deps = SendDeps
export const handle = (req: Request, deps: Deps) => handleSend(req, deps, ['TEXT', 'MEDIA'], 'whatsapp-send-message')
