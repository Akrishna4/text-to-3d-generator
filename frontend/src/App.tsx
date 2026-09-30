/**
 * App.tsx — root component
 *
 * Orchestrates:
 *   - Sidebar: prompt input, example chips, generate button, status, download, history
 *   - Canvas area: ModelViewer (when a model is ready) or empty/loading state
 *   - useJobPoller: polls backend for job status
 *   - fetchSamples: loads pre-baked models for "Try an example" buttons
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ModelViewer } from './ModelViewer'
import { useJobPoller } from './useJobPoller'
import { startGenerate, fetchSamples, type Sample } from './api'

// ── Example prompts shown as chips ────────────────────────────────────────────
const EXAMPLE_PROMPTS = [
  'a ceramic teapot',
  'an astronaut helmet',
  'a wooden chair',
  'a glass vase',
  'a fantasy sword',
  'a robot figure',
]

const MAX_PROMPT = 300

// ── History entry ─────────────────────────────────────────────────────────────
interface HistoryEntry {
  jobId: string
  prompt: string
  modelUrl: string
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [prompt, setPrompt]       = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [jobId, setJobId]         = useState<string | null>(null)
  const [activeUrl, setActiveUrl] = useState<string | null>(null)
  const [history, setHistory]     = useState<HistoryEntry[]>([])
  const [samples, setSamples]     = useState<Sample[]>([])
  const [elapsed, setElapsed]     = useState(0)
  const elapsedRef                = useRef<ReturnType<typeof setInterval> | null>(null)

  const { job, error: pollError } = useJobPoller(jobId)

  // ── Load samples on mount ─────────────────────────────────────────────────
  useEffect(() => {
    fetchSamples().then(setSamples)
  }, [])

  // ── Elapsed timer ─────────────────────────────────────────────────────────
  // Runs while a job is active; stops at terminal state.
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
    return () => {
      if (elapsedRef.current) clearInterval(elapsedRef.current)
    }
  }, [job?.status])

  // ── React to job completion ───────────────────────────────────────────────
  useEffect(() => {
    if (job?.status === 'done' && job.model_url) {
      setActiveUrl(job.model_url)
      // Add to session history (avoid duplicates)
      setHistory(h => {
        if (h.some(e => e.jobId === job.job_id)) return h
        return [{ jobId: job.job_id, prompt: job.prompt, modelUrl: job.model_url! }, ...h]
      })
    }
  }, [job?.status, job?.model_url])

  // ── Generate ──────────────────────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    setJobId(null)
    setActiveUrl(null)
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

  // ── Download ──────────────────────────────────────────────────────────────
  const handleDownload = () => {
    if (!activeUrl) return
    const a = document.createElement('a')
    a.href = activeUrl
    a.download = ''   // server sets Content-Disposition with prompt-derived name
    a.click()
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const isGenerating = job?.status === 'queued' || job?.status === 'running' || submitting
  const canGenerate  = prompt.trim().length > 0 && !isGenerating
  const canDownload  = !!activeUrl && job?.status === 'done'

  const currentStatus = submitting
    ? 'running'
    : job?.status ?? (submitError ? 'failed' : 'idle')

  const loadingStep = job?.status === 'queued'
    ? 'Step 1/2: Waiting for GPU…'
    : job?.status === 'running'
    ? elapsed < 15
      ? 'Step 1/2: Generating reference image with FLUX…'
      : 'Step 2/2: Reconstructing 3D mesh with Hunyuan3D-2…'
    : ''

  return (
    <div className="app">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <header className="header">
        <div className="logo">
          <div className="logo-dot" />
          OneImmersive · Text to 3D
        </div>
        <span className="header-badge">AI Demo</span>
      </header>

      {/* ── Main layout ───────────────────────────────────────────────── */}
      <div className="main">

        {/* ── Sidebar ─────────────────────────────────────────────────── */}
        <aside className="sidebar">

          {/* Prompt */}
          <div className="sidebar-section">
            <h2>Prompt</h2>
            <div className="prompt-wrapper">
              <textarea
                id="prompt-input"
                className="prompt-input"
                placeholder="Describe a 3D object… e.g. a ceramic teapot"
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                maxLength={MAX_PROMPT}
                disabled={isGenerating}
                rows={4}
              />
              <span className={`char-count ${prompt.length > MAX_PROMPT * 0.85 ? 'warn' : ''}`}>
                {prompt.length}/{MAX_PROMPT}
              </span>
            </div>
          </div>

          {/* Example chips */}
          <div className="sidebar-section">
            <h2>Examples</h2>
            <div className="chips">
              {EXAMPLE_PROMPTS.map(p => (
                <button
                  key={p}
                  className="chip"
                  onClick={() => setPrompt(p)}
                  disabled={isGenerating}
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

          {/* Status */}
          {(job || submitError || submitting) && (
            <div className="status-box">
              <div className="status-row">
                <div className={`status-dot ${currentStatus}`} />
                <span className="status-label">{currentStatus}</span>
                {isGenerating && (
                  <span className="status-elapsed">{elapsed}s</span>
                )}
                {job?.status === 'done' && (
                  <span className="status-elapsed">{job.elapsed_s}s total</span>
                )}
              </div>
              {loadingStep && <div className="loading-step">{loadingStep}</div>}
              {(job?.error || submitError) && (
                <div className="status-error">{job?.error ?? submitError}</div>
              )}
              {pollError && !job?.error && (
                <div className="status-msg">{pollError}</div>
              )}
            </div>
          )}

          {/* Download */}
          <button
            id="download-btn"
            className="btn-download"
            onClick={handleDownload}
            disabled={!canDownload}
          >
            ↓ Download GLB
          </button>

          {/* Pre-baked samples */}
          {samples.length > 0 && (
            <div className="sidebar-section">
              <h2>Sample Models</h2>
              <div className="samples-grid">
                {samples.map(s => (
                  <button
                    key={s.model_url}
                    className="sample-btn"
                    onClick={() => setActiveUrl(s.model_url)}
                  >
                    ◈ {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Session history */}
          {history.length > 0 && (
            <div className="sidebar-section">
              <h2>History</h2>
              <div className="history-list">
                {history.map(h => (
                  <button
                    key={h.jobId}
                    className={`history-item ${activeUrl === h.modelUrl ? 'active' : ''}`}
                    onClick={() => setActiveUrl(h.modelUrl)}
                    title={h.prompt}
                  >
                    {h.prompt}
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* ── Canvas area ───────────────────────────────────────────────── */}
        <div className="canvas-area">
          {activeUrl ? (
            <>
              <ModelViewer modelUrl={activeUrl} />
              <div className="canvas-hint">
                🖱 Drag to rotate · Scroll to zoom · Right-drag to pan
              </div>
            </>
          ) : isGenerating ? (
            <div className="loading-overlay">
              <div className="spinner" />
              <div className="loading-text">
                <div>{loadingStep || 'Starting generation…'}</div>
                <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  This typically takes 90–120 seconds
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">◈</div>
              <h3>Your 3D model will appear here</h3>
              <p>
                Enter a prompt in the sidebar and click Generate — or try a
                sample model to see the viewer in action.
              </p>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
