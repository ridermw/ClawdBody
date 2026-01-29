import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { decrypt } from '@/lib/encryption'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check if a specific VM is requested
    const { searchParams } = new URL(request.url)
    const vmId = searchParams.get('vmId')

    let orgoComputerId: string | null = null

    // If vmId is provided, get the computer ID from the VM model
    if (vmId) {
      const vm = await prisma.vM.findFirst({
        where: { id: vmId, userId: session.user.id },
      })

      if (!vm) {
        return NextResponse.json({ error: 'VM not found' }, { status: 404 })
      }

      if (vm.provider !== 'orgo') {
        return NextResponse.json({ error: 'Screenshot only available for Orgo VMs' }, { status: 400 })
      }

      orgoComputerId = vm.orgoComputerId
    } else {
      // Fall back to SetupState for backward compatibility
      const setupState = await prisma.setupState.findUnique({
        where: { userId: session.user.id },
      })
      orgoComputerId = setupState?.orgoComputerId || null
    }

    if (!orgoComputerId) {
      return NextResponse.json({ error: 'VM not created yet' }, { status: 404 })
    }

    // Get Orgo API key from setup state or environment
    const setupState = await prisma.setupState.findUnique({
      where: { userId: session.user.id },
      select: { orgoApiKey: true },
    })
    
    const orgoApiKeyEncrypted = setupState?.orgoApiKey
    const orgoApiKeyEnv = process.env.ORGO_API_KEY
    if (!orgoApiKeyEncrypted && !orgoApiKeyEnv) {
      return NextResponse.json({ error: 'Orgo API key not configured' }, { status: 500 })
    }
    
    // Decrypt stored key or use env variable (which is not encrypted)
    const orgoApiKey = orgoApiKeyEncrypted ? decrypt(orgoApiKeyEncrypted) : orgoApiKeyEnv!

    // Fetch screenshot directly from Orgo API (bypass OrgoClient to handle binary response)
    const ORGO_API_BASE = 'https://www.orgo.ai/api'
    
    // Add timeout to screenshot requests
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout
    
    try {
      const response = await fetch(
        `${ORGO_API_BASE}/computers/${orgoComputerId}/screenshot`,
        {
          signal: controller.signal,
          headers: {
            'Authorization': `Bearer ${orgoApiKey}`,
          },
        }
      )
      
      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorText = await response.text()
        const status = response.status
        
        // Handle 502 Bad Gateway errors gracefully (often means VM is starting up or proxy issue)
        if (status === 502) {
          return NextResponse.json(
            { error: 'VM is not ready yet. Please wait a moment and try again.' },
            { status: 503 } // Service Unavailable - indicates temporary unavailability
          )
        }
        
        // Handle 404 - computer doesn't exist (deleted from Orgo)
        if (status === 404) {
          // Reset the setup state since computer is gone
          try {
            await prisma.setupState.update({
              where: { userId: session.user.id },
              data: {
                status: 'pending',
                orgoProjectId: null,
                orgoComputerId: null,
                orgoComputerUrl: null,
                vmStatus: null,
                vmCreated: false,
                errorMessage: null,
              },
            })
          } catch (updateError) {
            // Failed to reset state
          }
          return NextResponse.json(
            { error: 'Computer not found - it may have been deleted', deleted: true },
            { status: 404 }
          )
        }
        throw new Error(`Failed to fetch screenshot: ${status}`)
      }

      // Check content type to determine response format
      const contentType = response.headers.get('content-type') || ''
      
      if (contentType.includes('application/json')) {
        // JSON response - try to parse
        try {
          const data = await response.json()
          // Handle different possible response formats
          let imageData = data.image || data.data || data.screenshot
          
          if (!imageData) {
            throw new Error('No image data found in response')
          }
          
          // Check if imageData is a URL (starts with http/https)
          if (typeof imageData === 'string' && (imageData.startsWith('http://') || imageData.startsWith('https://'))) {
            // Prefer returning URL directly to reduce egress (frontend can fetch it)
            // Only fetch and convert if explicitly requested
            const fetchImage = request.nextUrl.searchParams.get('fetch') === 'true'
            
            if (!fetchImage) {
              // Return URL directly - saves egress by letting frontend fetch directly
              return NextResponse.json({
                imageUrl: imageData,
              })
            }
            
            // Only fetch if explicitly requested
            try {
              const imageResponse = await fetch(imageData)
              if (!imageResponse.ok) {
                throw new Error(`Failed to fetch image from URL: ${imageResponse.status}`)
              }
              const arrayBuffer = await imageResponse.arrayBuffer()
              
              // Limit image size to prevent excessive egress (max 2MB)
              const MAX_IMAGE_SIZE = 2 * 1024 * 1024
              if (arrayBuffer.byteLength > MAX_IMAGE_SIZE) {
                // Return URL instead if image is too large
                return NextResponse.json({
                  imageUrl: imageData,
                  warning: 'Image too large, using direct URL',
                })
              }
              
              const buffer = Buffer.from(arrayBuffer)
              const base64 = buffer.toString('base64')
              
              return NextResponse.json({
                image: base64,
                imageUrl: imageData, // Also return the URL for direct use if needed
              })
            } catch (urlError) {
              // Fall through to return URL directly
              return NextResponse.json({
                imageUrl: imageData, // Return URL directly - frontend can use it
              })
            }
          }
          
          // Check if it's a data URL with base64
          if (imageData.startsWith('data:image/')) {
            // Remove data URL prefix (e.g., "data:image/png;base64,")
            const base64Data = imageData.replace(/^data:image\/[a-z]+;base64,/, '')
            return NextResponse.json({
              image: base64Data,
            })
          }
          
          // Assume it's already base64 if it matches base64 pattern
          if (/^[A-Za-z0-9+/=]+$/.test(imageData.trim())) {
            return NextResponse.json({
              image: imageData.trim(),
            })
          }
          
          // If none of the above, return as-is (might be a URL we didn't catch)
          return NextResponse.json({
            imageUrl: imageData,
          })
        } catch (jsonError) {
          throw new Error('Invalid JSON response from screenshot API')
        }
      } else if (contentType.includes('image/')) {
        // Binary image response - convert to base64
        const arrayBuffer = await response.arrayBuffer()
        
        // Limit image size to prevent excessive egress (max 2MB)
        const MAX_IMAGE_SIZE = 2 * 1024 * 1024
        if (arrayBuffer.byteLength > MAX_IMAGE_SIZE) {
          return NextResponse.json(
            { error: 'Screenshot too large. Please try again or contact support.' },
            { status: 413 } // Payload Too Large
          )
        }
        
        const buffer = Buffer.from(arrayBuffer)
        const base64 = buffer.toString('base64')
        
        return NextResponse.json({
          image: base64,
        })
      } else {
        // Unknown format - try to get as text and see if it's base64
        const text = await response.text()
        
        // Check if it's already base64 (no data URL prefix)
        if (/^[A-Za-z0-9+/=]+$/.test(text.trim())) {
          return NextResponse.json({
            image: text.trim(),
          })
        }
        
        throw new Error(`Unexpected content type: ${contentType}`)
      }
    } catch (fetchError: any) {
      clearTimeout(timeoutId)
      if (fetchError.name === 'AbortError' || fetchError.message?.includes('timeout')) {
        return NextResponse.json(
          { error: 'Screenshot request timed out. The VM may still be starting up.' },
          { status: 504 }
        )
      }
      throw fetchError
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get screenshot' },
      { status: 500 }
    )
  }
}

