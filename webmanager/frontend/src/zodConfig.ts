// Imported first in main.tsx, before anything that builds a zod schema (the
// vendored claude-conversation-schema). Left alone, zod probes whether it
// may compile parsers with Function(), and under the SPA's CSP
// (script-src 'self', backend/static.go) the browser reports that probe as
// a violation on every load. jitless skips the probe and the compiled path.
import { z } from 'zod'

z.config({ jitless: true })
