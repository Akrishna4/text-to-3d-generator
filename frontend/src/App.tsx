/**
 * App.tsx — root component
 *
 * Orchestrates:
 *   - Header: logo mark + title + tagline
 *   - Left panel: prompt textarea, example chips, generate button,
 *                 progress card (or failure notice), download, samples, history
 *   - Viewer area: ModelViewer (auto-loads first sample on mount),
 *                  viewer badge, interaction hint, loading overlay
 *   - useJobPoller: polls backend for job status
 */

import './App.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ModelViewer } from './ModelViewer'
import { useJobPoller } from './useJobPoller'
import { startGenerate, fetchSamples, type Sample } from './api'

// ── Example prompts ──────────────────────────────────────────────────────────
const EXAMPLE_PROMPTS = [
  'a ceramic teapot',
  'an astronaut helmet',
  'a wooden chair',
  'a glass vase',
  'a fantasy sword',
  'a robot figure',
]

const MAX_PROMPT = 300

// ── Derive a short display name from a model URL ─────────────────────────────
function urlToFilename(url: string): string {
  const parts = url.split('/')
  return parts[parts.length - 1] || url
}

// ── History entry ────────────────────────────────────────────────────────────
interface HistoryEntry {
  jobId: string
  prompt: string
  modelUrl: string
}

// ── ViewerMeta: what is currently shown in the viewer ───────────────────────
interface ViewerMeta {
  url: string
  label: string
  kind: 'sample' | 'generated' | 'loading'
}

// ── Detect touch capability (for hint text) ──────────────────────────────────
const isTouch = typeof window !== 'undefined' &&
  ('ontouchstart' in window || navigator.maxTouchPoints > 0)

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [prompt, setPrompt]           = useState('')
  const [submitting, setSubmitting]   = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [jobId, setJobId]             = useState<string | null>(null)
  const [viewer, setViewer]           = useState<ViewerMeta | null>(null)
  const [history, setHistory]         = useState<HistoryEntry[]>([])
  const [samples, setSamples]         = useState<Sample[]>([])
  const [elapsed, setElapsed]         = useState(0)
  const [hintHidden, setHintHidden]   = useState(false)
  const [historyOpen, setHistoryOpen] = useState(true)
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { job, error: pollError } = useJobPoller(jobId)

  // ── Load samples on mount; auto-display the first one ───────────────────
  useEffect(() => {
    fetchSamples().then(list => {
      setSamples(list)
      if (list.length > 0 && !viewer) {
        setViewer({ url: list[0].model_url, label: list[0].label, kind: 'sample' })
      }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Elapsed timer (counts while job is active) ───────────────────────────
  useEffect(() => {
    if (job?.status === 'queued' || job?.status === 'running') {
      if (!elapsedRef.current) {
        setElapsed(0)
        elapsedRef.current = setInterval(() => setElapsed(s => s + 1), 1000)
      }
    } else {
      if (elapsedRef.current) {
        clearInterval(elapsedRef.current)
        elapsedRef.current = null
      }
    }
    return () => { if (elapsedRef.current) clearInterval(elapsedRef.current) }
  }, [job?.status])

  // ── React to job completion ──────────────────────────────────────────────
  useEffect(() => {
    if (job?.status === 'done' && job.model_url) {
      setViewer({ url: job.model_url, label: job.prompt, kind: 'generated' })
      setHistory(h => {
        if (h.some(e => e.jobId === job.job_id)) return h
        return [{ jobId: job.job_id, prompt: job.prompt, modelUrl: job.model_url! }, ...h]
      })
    }
  }, [job?.status, job?.model_url])

  // ── Generate ────────────────────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    setJobId(null)
    // Don't clear the viewer yet — keep the last model visible during queuing
    setElapsed(0)

    try {
      const { job_id } = await startGenerate(prompt.trim())
      setJobId(job_id)
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to start generation.')
    } finally {
      setSubmitting(false)
    }
  }, [prompt, submitting])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate()
  }

  // ── Download ─────────────────────────────────────────────────────────────
  const handleDownload = () => {
    if (!viewer?.url) return
    const a = document.createElement('a')
    a.href = viewer.url
    a.download = ''  // server sets Content-Disposition
    a.click()
  }

  // ── Load a sample ─────────────────────────────────────────────────────────
  const handleLoadSample = (s: Sample) => {
    setViewer({ url: s.model_url, label: s.label, kind: 'sample' })
    setJobId(null)
    setSubmitError(null)
  }

  // ── Retry after failure ───────────────────────────────────────────────────
  const handleRetry = () => {
    setJobId(null)
    setSubmitError(null)
    handleGenerate()
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const isGenerating  = submitting || job?.status === 'queued' || job?.status === 'running'
  const canGenerate   = prompt.trim().length > 0 && !isGenerating
  const canDownload   = !!viewer?.url && viewer.kind === 'generated' && job?.status === 'done'
  const isFailed      = job?.status === 'failed' || !!submitError
  const failureMsg    = job?.error ?? submitError ?? null

  const currentStatus = submitting
    ? 'running'
    : job?.status ?? (submitError ? 'failed' : null)

  // Progress bar fill: 0–100 based on elapsed vs expected ~100s
  const EXPECTED_S = 100
  const progressPct = isGenerating
    ? Math.min((elapsed / EXPECTED_S) * 100, 90) // cap at 90% until done
    : job?.status === 'done' ? 100 : 0

  const loadingStep = job?.status === 'queued'
    ? 'Waiting for GPU…'
    : job?.status === 'running'
    ? elapsed < 15
      ? 'Generating reference image with FLUX…'
      : 'Reconstructing 3D mesh with Hunyuan3D-2…'
    : submitting
    ? 'Starting…'
    : ''

  // Hint text depends on touch capability
  const hintText = isTouch
    ? 'Drag to rotate · Pinch to zoom'
    : 'Drag to rotate · Scroll to zoom · Right-drag to pan'

  return (
    <div className="app">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-brand">
          <h1 className="header-title">
            <span className="header-mark" aria-hidden="true">3D</span>
            Text to 3D
          </h1>
          <span className="header-sub">Describe an object. Get a downloadable 3D model.</span>
        </div>
      </header>

      {/* ── Main layout ─────────────────────────────────────────────────── */}
      <div className="main">

        {/* ── Viewer (right / top on mobile) ──────────────────────────── */}
        <div className="canvas-area" role="region" aria-label="3D model viewer">
          {viewer ? (
            <>
              <ModelViewer
                modelUrl={viewer.url}
                onInteract={() => setHintHidden(true)}
              />

              {/* Badge: Sample / Generated */}
              <div className={`viewer-badge${viewer.kind === 'generated' ? ' generated' : ''}`}>
                {viewer.kind === 'generated' ? 'Generated' : 'Sample'}
              </div>

              {/* Model label */}
              <div className="viewer-label" aria-hidden="true">
                {viewer.label}
              </div>

              {/* Interaction hint — fades after first interaction */}
              <div
                className={`canvas-hint${hintHidden ? ' hidden' : ''}`}
                aria-hidden="true"
              >
                {hintText}
              </div>
            </>
          ) : isGenerating ? (
            <div className="empty-state">
              <div className="spinner" />
              <div>
                <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                  {loadingStep || 'Starting…'}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 6 }}>
                  Usually 1–3 minutes on free GPUs
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon" aria-hidden="true">◈</div>
              <h3>Your 3D model will appear here</h3>
              <p>Enter a prompt and click Generate, or load a sample from the panel.</p>
            </div>
          )}
        </div>

        {/* ── Left panel (sidebar) ─────────────────────────────────────── */}
        <aside className="sidebar" aria-label="Controls">

          {/* Prompt */}
          <div>
            <div className="section-label" id="prompt-label">Prompt</div>
            <div className="prompt-wrapper">
              <textarea
                id="prompt-input"
                className="prompt-input"
                aria-labelledby="prompt-label"
                placeholder="e.g. a ceramic teapot with a bamboo handle"
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                maxLength={MAX_PROMPT}
                disabled={isGenerating}
                rows={4}
              />
              <span
                className={`char-count${prompt.length > MAX_PROMPT * 0.85 ? ' warn' : ''}`}
                aria-live="polite"
                aria-atomic="true"
              >
                {prompt.length}/{MAX_PROMPT}
              </span>
            </div>
            <p className="prompt-hint">Cmd/Ctrl+Enter to generate</p>
          </div>

          {/* Example chips */}
          <div>
            <div className="section-label">Examples</div>
            <div className="chips" role="list">
              {EXAMPLE_PROMPTS.map(p => (
                <button
                  key={p}
                  role="listitem"
                  className="chip"
                  onClick={() => setPrompt(p)}
                  disabled={isGenerating}
                  aria-label={`Use example: ${p}`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Generate */}
          <button
            id="generate-btn"
            className="btn-generate"
            onClick={handleGenerate}
            disabled={!canGenerate}
            aria-busy={isGenerating}
          >
            {isGenerating ? (
              <>
                <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                Generating…
              </>
            ) : (
              <>✦ Generate 3D Model</>
            )}
          </button>

          {/* Progress card — while running */}
          {(isGenerating || (job && !isFailed)) && (
            <div
              className="progress-card"
              role="status"
              aria-live="polite"
              aria-label="Generation status"
            >
              <div className="progress-top">
                <div className={`progress-dot ${currentStatus ?? 'running'}`} aria-hidden="true" />
                <span className="progress-status">
                  {currentStatus === 'done' ? 'Complete' : currentStatus ?? 'Running'}
                </span>
                {(isGenerating || job?.status === 'done') && (
                  <span className="progress-elapsed">
                    {job?.status === 'done'
                      ? `${Math.round(job.elapsed_s)}s`
                      : `${elapsed}s`}
                  </span>
                )}
              </div>

              {/* Progress bar */}
              <div className="progress-bar-track" aria-hidden="true">
                <div
                  className={`progress-bar-fill${isGenerating && elapsed < 3 ? ' indeterminate' : ''}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>

              {loadingStep && (
                <div className="progress-step">{loadingStep}</div>
              )}

              {isGenerating && (
                <div className="progress-expectation">
                  Usually 1–3 minutes on free GPUs
                </div>
              )}
            </div>
          )}

          {/* Failure notice */}
          {isFailed && (
            <div
              className="failure-notice"
              role="alert"
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="failure-icon" aria-hidden="true">⚠</span>
                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--status-failed)' }}>
                  Generation failed
                </span>
              </div>
              {failureMsg && (
                <p className="failure-message">{failureMsg}</p>
              )}
              <div className="failure-actions">
                <button className="btn-ghost" onClick={handleRetry}>
                  Try again
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => samples[0] && handleLoadSample(samples[0])}
                  disabled={samples.length === 0}
                >
                  Browse samples
                </button>
              </div>
            </div>
          )}

          {/* Poll network error (transient, non-fatal) */}
          {pollError && !isFailed && (
            <div className="poll-error" role="status" aria-live="polite">
              {pollError}
            </div>
          )}

          <hr className="divider" />

          {/* Download */}
          <div className="download-area">
            <div className="section-label">Download</div>
            {canDownload && viewer?.url && (
              <div className="download-filename" title={urlToFilename(viewer.url)}>
                {urlToFilename(viewer.url)}
              </div>
            )}
            <button
              id="download-btn"
              className="btn-download"
              onClick={handleDownload}
              disabled={!canDownload}
              aria-label={canDownload ? `Download ${urlToFilename(viewer?.url ?? '')}` : 'No model to download yet'}
            >
              ↓ Download GLB
            </button>
          </div>

          {/* Sample models */}
          {samples.length > 0 && (
            <div>
              <div className="section-label">Sample Models</div>
              <div className="samples-list" role="list">
                {samples.map(s => (
                  <button
                    key={s.model_url}
                    role="listitem"
                    className={`sample-card${viewer?.url === s.model_url && viewer?.kind === 'sample' ? ' active' : ''}`}
                    onClick={() => handleLoadSample(s)}
                    aria-label={`Load sample: ${s.label}`}
                    aria-pressed={viewer?.url === s.model_url && viewer?.kind === 'sample'}
                  >
                    <span className="sample-icon" aria-hidden="true">◈</span>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Session history */}
          {history.length > 0 && (
            <div>
              <div className="history-header" onClick={() => setHistoryOpen(o => !o)}>
                <div className="section-label" style={{ marginBottom: 0 }}>
                  History ({history.length})
                </div>
                <button
                  className="history-toggle"
                  aria-expanded={historyOpen}
                  aria-controls="history-list"
                  onClick={e => { e.stopPropagation(); setHistoryOpen(o => !o) }}
                >
                  {historyOpen ? '▲ collapse' : '▼ expand'}
                </button>
              </div>
              {historyOpen && (
                <div className="history-list" id="history-list" role="list">
                  {history.map(h => (
                    <button
                      key={h.jobId}
                      role="listitem"
                      className={`history-item${viewer?.url === h.modelUrl ? ' active' : ''}`}
                      onClick={() => setViewer({ url: h.modelUrl, label: h.prompt, kind: 'generated' })}
                      title={h.prompt}
                      aria-pressed={viewer?.url === h.modelUrl}
                    >
                      {h.prompt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

        </aside>
      </div>
    </div>
  )
}
