/**
 * useJobPoller.ts
 * ---------------
 * Custom hook that polls GET /api/jobs/:id every POLL_INTERVAL ms until the
 * job reaches a terminal state (done | failed).
 *
 * Why a custom hook?
 *   - Keeps polling logic out of App.tsx
 *   - Cleans up the interval automatically via useEffect cleanup
 *   - Returns the full job object so the UI can show elapsed time, errors, etc.
 */

import { useEffect, useRef, useState } from 'react'
import { pollJob, type JobResponse } from './api'

const POLL_INTERVAL = 3000   // ms — 3 s is a good balance for 60-120 s jobs
const MAX_POLLS     = 110    // 110 × 3 s = 330 s (5 min 30 s) — outlasts the server's 5-min timeout
const POLL_TIMEOUT_MSG =
  'No response from the server after 5 minutes. The job may still be running — ' +
  'refresh the page or try again later.'

export function useJobPoller(jobId: string | null) {
  const [job, setJob]     = useState<JobResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const intervalRef       = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollCountRef      = useRef(0)

  useEffect(() => {
    if (!jobId) {
      setJob(null)
      setError(null)
      return
    }

    // Reset on new job
    setJob(null)
    setError(null)
    pollCountRef.current = 0

    const poll = async () => {
      pollCountRef.current += 1

      // Client-side timeout guard: stop polling after MAX_POLLS attempts
      if (pollCountRef.current > MAX_POLLS) {
        if (intervalRef.current) clearInterval(intervalRef.current)
        setError(POLL_TIMEOUT_MSG)
        return
      }

      try {
        const data = await pollJob(jobId)
        setJob(data)
        // Stop polling when job is in a terminal state
        if (data.status === 'done' || data.status === 'failed') {
          if (intervalRef.current) clearInterval(intervalRef.current)
        }
      } catch (err) {
        setError('Lost connection to server. Retrying…')
        // Keep polling — transient network errors shouldn't kill the job
      }
    }

    // Poll immediately, then on interval
    poll()
    intervalRef.current = setInterval(poll, POLL_INTERVAL)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [jobId])

  return { job, error }
}
