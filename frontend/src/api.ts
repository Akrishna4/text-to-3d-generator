/**
 * api.ts — typed wrappers around the backend REST API
 *
 * All functions throw on network errors; callers should catch and display
 * user-friendly messages.
 */

const API_BASE = '/api'

export interface GenerateResponse {
  job_id: string
  status: string
}

export interface JobResponse {
  job_id: string
  status: 'queued' | 'running' | 'done' | 'failed'
  prompt: string
  created_at: number
  updated_at: number
  elapsed_s: number
  model_url: string | null
  error: string | null
}

export interface Sample {
  label: string
  model_url: string
}

/**
 * POST /api/generate — start a generation job
 * Returns immediately with a job_id.
 */
export async function startGenerate(prompt: string): Promise<GenerateResponse> {
  const resp = await fetch(`${API_BASE}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    // FastAPI validation errors come as {detail: [{msg: ...}]}
    const msg =
      Array.isArray(err.detail)
        ? err.detail.map((d: { msg: string }) => d.msg).join('; ')
        : (err.detail ?? `HTTP ${resp.status}`)
    throw new Error(msg)
  }

  return resp.json()
}

/**
 * GET /api/jobs/:id — poll for job status
 */
export async function pollJob(jobId: string): Promise<JobResponse> {
  const resp = await fetch(`${API_BASE}/jobs/${jobId}`)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

/**
 * GET /api/samples — fetch pre-baked sample model list
 */
export async function fetchSamples(): Promise<Sample[]> {
  const resp = await fetch(`${API_BASE}/samples`)
  if (!resp.ok) return []
  const data = await resp.json()
  return data.samples ?? []
}
