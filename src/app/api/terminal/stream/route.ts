/**
 * Terminal Stream API
 * 
 * Streams terminal output via Server-Sent Events (SSE).
 * Optimized to reduce egress by batching outputs and using adaptive polling.
 */

import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sessionOutputBuffers } from '@/lib/terminal/session-buffers'

// Configuration for egress optimization
const POLL_INTERVAL_ACTIVE = 100 // 100ms when there's active output (reduced from 50ms)
const POLL_INTERVAL_IDLE = 500 // 500ms when idle (adaptive polling)
const BATCH_SIZE = 50 // Batch up to 50 outputs per message
const MAX_MESSAGE_SIZE = 100000 // ~100KB max per SSE message

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const sessionId = request.nextUrl.searchParams.get('sessionId')

  if (!sessionId) {
    return new Response('Missing sessionId', { status: 400 })
  }

  // Verify session belongs to user
  if (!sessionId.startsWith(session.user.id)) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Create SSE stream with optimized batching and adaptive polling
  const encoder = new TextEncoder()
  let lastIndex = 0
  let intervalId: ReturnType<typeof setInterval> | null = null
  let isClosed = false
  let consecutiveEmptyPolls = 0
  let currentPollInterval = POLL_INTERVAL_ACTIVE

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connected message
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)
      )

      const poll = () => {
        if (isClosed) {
          if (intervalId) clearInterval(intervalId)
          return
        }

        const buffer = sessionOutputBuffers.get(sessionId)
        
        if (!buffer) {
          // Session ended
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'system', data: 'Session ended\r\n' })}\n\n`)
            )
            controller.close()
          } catch (e) {
            // Controller might already be closed
          }
          isClosed = true
          if (intervalId) clearInterval(intervalId)
          return
        }

        // Check if there's new output
        const newOutputCount = buffer.length - lastIndex
        
        if (newOutputCount === 0) {
          // No new output - use adaptive polling
          consecutiveEmptyPolls++
          if (consecutiveEmptyPolls > 5 && currentPollInterval === POLL_INTERVAL_ACTIVE) {
            // Switch to idle polling after 5 empty polls
            currentPollInterval = POLL_INTERVAL_IDLE
            if (intervalId) clearInterval(intervalId)
            intervalId = setInterval(poll, currentPollInterval)
          }
          return
        }

        // Reset to active polling when we have data
        consecutiveEmptyPolls = 0
        if (currentPollInterval !== POLL_INTERVAL_ACTIVE) {
          currentPollInterval = POLL_INTERVAL_ACTIVE
          if (intervalId) clearInterval(intervalId)
          intervalId = setInterval(poll, currentPollInterval)
        }

        // Batch outputs together to reduce SSE message overhead
        const batches: string[][] = []
        let currentBatch: string[] = []
        let currentBatchSize = 0

        while (lastIndex < buffer.length) {
          try {
            const output = buffer[lastIndex]
            const outputSize = output.length
            
            // If adding this output would exceed batch size or message size, start a new batch
            if (
              currentBatch.length >= BATCH_SIZE ||
              (currentBatchSize + outputSize > MAX_MESSAGE_SIZE && currentBatch.length > 0)
            ) {
              batches.push(currentBatch)
              currentBatch = []
              currentBatchSize = 0
            }

            currentBatch.push(output)
            currentBatchSize += outputSize
            lastIndex++
          } catch (e) {
            // Controller might be closed
            isClosed = true
            if (intervalId) clearInterval(intervalId)
            return
          }
        }

        // Add the last batch if it has items
        if (currentBatch.length > 0) {
          batches.push(currentBatch)
        }

        // Send batched outputs
        for (const batch of batches) {
          try {
            if (batch.length === 1) {
              // Single output - send as-is for backward compatibility
              controller.enqueue(encoder.encode(`data: ${batch[0]}\n\n`))
            } else {
              // Multiple outputs - batch them together
              // Parse each output and combine into a single message
              const parsedOutputs = batch.map(item => {
                try {
                  return JSON.parse(item)
                } catch {
                  // If parsing fails, wrap it
                  return { type: 'output', data: item }
                }
              })
              
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: 'batch', outputs: parsedOutputs })}\n\n`)
              )
            }
          } catch (e) {
            // Controller might be closed
            isClosed = true
            if (intervalId) clearInterval(intervalId)
            return
          }
        }
      }

      // Start polling
      intervalId = setInterval(poll, currentPollInterval)
    },
    cancel() {
      // Clean up when client disconnects
      isClosed = true
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
      // Note: Compression for SSE is typically handled by the platform (Vercel, etc.)
      // but we can't explicitly set it here as it may interfere with streaming
    },
  })
}
