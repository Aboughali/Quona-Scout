import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Exposes the local scan runner to the app as POST /api/scan (and GET /api/scan/status).
 *
 * This exists so "Run Web Scan Now" can trigger a real Apify run while keeping APIFY_TOKEN on
 * the server side -- the token is read from .env inside the Node process and is never sent to
 * the browser. It is a DEV-ONLY middleware: `vite build` produces a static bundle with no
 * endpoint, which is correct for now, since Phase 1 is explicitly a local-testing setup.
 *
 * To move to a weekly scheduled run later, deploy `executeScan()` as a serverless function and
 * point the frontend's SCAN_ENDPOINT at it -- the handler body below is the whole adapter.
 */
function scanApiPlugin(): Plugin {
  return {
    name: 'quona-scan-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/scan', async (req, res) => {
        res.setHeader('Content-Type', 'application/json')

        if (req.method === 'GET') {
          try {
            const { loadFindings, loadScanRuns, loadConfig } = await import('./scripts/scan/storage.mjs')
            const [findings, runs, config] = await Promise.all([loadFindings(), loadScanRuns(), loadConfig()])
            res.end(JSON.stringify({
              ok: true,
              findingCount: findings.length,
              lastRun: runs.at(-1) ?? null,
              sources: config.sources.map((s: Record<string, unknown>) => ({
                name: s.name, domain: s.domain, enabled: s.enabled, sourceType: s.sourceType,
                accessMethod: s.accessMethod, priority: s.priority, lastScan: s.lastScan,
                lastSuccess: s.lastSuccess, note: s.note,
              })),
            }))
          } catch (err) {
            res.statusCode = 500
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }))
          }
          return
        }

        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'Use POST to run a scan.' }))
          return
        }

        const lines: string[] = []
        try {
          const { executeScan } = await import('./scripts/scan/cli.mjs')
          const result = await executeScan({
            log: (m: string) => { lines.push(m); console.log(`[scan] ${m}`) },
          })
          res.statusCode = result.ok ? 200 : 400
          res.end(JSON.stringify({ ...result, log: lines }))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, error: (err as Error).message, log: lines }))
        }
      })
    },
  }
}

/**
 * Exposes the traction analyser to the app as POST /api/traction, plus GET /api/traction/file
 * to re-open a stored document.
 *
 * Same shape and same reasoning as the scan endpoint above: ANTHROPIC_API_KEY is read from .env
 * inside the Node process and never reaches the browser, and `analyseUpload()` is the whole
 * adapter -- deploying it as a serverless function is a matter of calling it from a different
 * wrapper. DEV-ONLY, so `vite build` still produces a purely static bundle.
 *
 * Uploads arrive as raw bytes with metadata in headers rather than as multipart or base64 JSON:
 * no parser dependency, and no 33% size inflation on a 15MB pitch deck.
 */
function tractionApiPlugin(): Plugin {
  /**
   * Bounds memory per request. Deliberately well above the 20MB PDF ceiling in extract.mjs:
   * a deck too large to send to the model should still be STORED on the company's profile with
   * an honest note, rather than refused at the door.
   */
  const MAX_UPLOAD_BYTES = 60 * 1024 * 1024

  const CONTENT_TYPES: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }

  return {
    name: 'quona-traction-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/traction', async (req, res) => {
        const [pathname, query] = (req.url ?? '/').split('?')

        // --- GET /api/traction/file?path=... : serve a stored document back ---
        if (req.method === 'GET' && pathname.startsWith('/file')) {
          try {
            const { resolveStoredFile } = await import('./scripts/traction/storage.mjs')
            const relPath = new URLSearchParams(query ?? '').get('path') ?? ''
            // resolveStoredFile refuses anything outside data/traction -- a null result is
            // treated as "not found" and the raw input path is never opened.
            const abs = resolveStoredFile(relPath)
            if (!abs) {
              res.statusCode = 404
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: 'File not found.' }))
              return
            }
            const { readFile } = await import('node:fs/promises')
            const nodePath = await import('node:path')
            const ext = nodePath.extname(abs).toLowerCase()
            res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream')
            res.setHeader('Content-Disposition', `inline; filename="${nodePath.basename(abs).replace(/"/g, '')}"`)
            res.end(await readFile(abs))
          } catch (err) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }))
          }
          return
        }

        res.setHeader('Content-Type', 'application/json')

        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'Use POST to upload a document.' }))
          return
        }

        // --- POST /api/traction : store the upload and summarise it ---
        const lines: string[] = []
        try {
          const header = (name: string) => {
            const raw = req.headers[name]
            const value = Array.isArray(raw) ? raw[0] : raw
            // Header values must be ASCII, so the client percent-encodes; a company name with
            // an accent or a filename with a space would otherwise be rejected by Node.
            return value ? decodeURIComponent(value) : ''
          }

          const buffer = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = []
            let size = 0
            let rejected = false
            req.on('data', (chunk: Buffer) => {
              if (rejected) return
              size += chunk.length
              if (size > MAX_UPLOAD_BYTES) {
                rejected = true
                const err = new Error(
                  `That file is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB upload limit. ` +
                  'Export a lighter version of the deck and try again.'
                ) as Error & { statusCode?: number }
                err.statusCode = 413
                // Drain the rest of the body rather than destroying the socket. Killing the
                // connection here is what made an oversized upload surface in the browser as a
                // bare "Failed to fetch" -- the response explaining the limit was never sent, so
                // the client could only guess that the server was unreachable.
                req.resume()
                reject(err)
                return
              }
              chunks.push(chunk)
            })
            req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)) })
            req.on('error', reject)
          })

          const { analyseUpload } = await import('./scripts/traction/analyse.mjs')
          const result = await analyseUpload({
            companyId: header('x-company-id'),
            companyName: header('x-company-name'),
            fileName: header('x-file-name') || 'upload',
            kind: (header('x-kind') || 'other') as 'pitch-deck' | 'financials' | 'other',
            buffer,
            log: (m: string) => { lines.push(m); console.log(`[traction] ${m}`) },
          })
          res.statusCode = result.ok ? 200 : 400
          res.end(JSON.stringify({ ...result, log: lines }))
        } catch (err) {
          // A size rejection carries its own status, so the browser gets a 413 and a readable
          // reason instead of a dead socket it can only report as a network failure.
          res.statusCode = (err as Error & { statusCode?: number }).statusCode ?? 500
          res.end(JSON.stringify({ ok: false, error: (err as Error).message, log: lines }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), scanApiPlugin(), tractionApiPlugin()],
  server: {
    // Honour a PORT assigned by the launcher. Vite does not read PORT on its own, and the port
    // was previously pinned with `--port 5183 --strictPort` in .claude/launch.json, which made
    // startup fail outright whenever another session already held that port. Nothing here
    // depends on a fixed port -- the scan/traction endpoints are served by this same dev server
    // on the same origin -- so falling back to Vite's default is fine when PORT is unset.
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
  },
})
