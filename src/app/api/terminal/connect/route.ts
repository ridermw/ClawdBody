/**
 * Terminal Connect API
 * 
 * Creates a new terminal session and starts an interactive shell.
 * Returns a session ID that can be used for subsequent operations.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getSessionManager, SSHTerminalProvider } from '@/lib/terminal'
import type { SSHConfig } from '@/lib/terminal'
import type { SetupState } from '@prisma/client'
import { sessionOutputBuffers } from '@/lib/terminal/session-buffers'
import { decrypt } from '@/lib/encryption'

// Extended type for AWS fields
type AWSSetupState = SetupState & {
  awsAccessKeyId?: string | null
  awsSecretAccessKey?: string | null
  awsRegion?: string | null
  awsInstanceType?: string | null
  awsInstanceId?: string | null
  awsInstanceName?: string | null
  awsPublicIp?: string | null
  awsPrivateKey?: string | null
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { cols = 80, rows = 24, vmId } = await request.json().catch(() => ({}))

    let vmProvider: string
    let awsPublicIp: string | null = null
    let awsPrivateKey: string | null = null

    // If vmId is provided, look up the VM from the VM model (multi-VM support)
    if (vmId) {
      const vm = await prisma.vM.findFirst({
        where: { id: vmId, userId: session.user.id },
      })

      if (!vm) {
        return NextResponse.json({ error: 'VM not found' }, { status: 404 })
      }

      vmProvider = vm.provider
      awsPublicIp = vm.awsPublicIp
      // Decrypt the private key from database
      awsPrivateKey = vm.awsPrivateKey ? decrypt(vm.awsPrivateKey) : null
    } else {
      // Fall back to SetupState for backward compatibility
    const setupState = await prisma.setupState.findUnique({
      where: { userId: session.user.id },
    })

    if (!setupState) {
      return NextResponse.json({ error: 'No VM configured' }, { status: 404 })
    }

      vmProvider = setupState.vmProvider || 'orgo'
      const awsState = setupState as AWSSetupState
      awsPublicIp = awsState.awsPublicIp || null
      // Decrypt the private key from database
      awsPrivateKey = awsState.awsPrivateKey ? decrypt(awsState.awsPrivateKey) : null
    }

    // Clean up any existing sessions for this user
    const sessionManager = getSessionManager()
    sessionManager.cleanupUserSessions(session.user.id)
    
    // Also clean up output buffers for old sessions
    Array.from(sessionOutputBuffers.keys()).forEach(key => {
      if (key.startsWith(`${session.user.id}-`)) {
        sessionOutputBuffers.delete(key)
      }
    })

    // Generate session ID
    const sessionId = `${session.user.id}-${Date.now()}`

    let sshConfig: SSHConfig

    if (vmProvider === 'aws') {
      if (!awsPublicIp || !awsPrivateKey) {
        return NextResponse.json(
          { error: 'AWS instance not fully configured' },
          { status: 400 }
        )
      }

      sshConfig = {
        sessionId,
        provider: 'aws',
        host: awsPublicIp,
        port: 22,
        username: 'ubuntu',
        privateKey: awsPrivateKey,
        cols,
        rows,
      }
    } else {
      // Orgo - would need SSH details from Orgo API
      // For now, return not implemented
      return NextResponse.json(
        { error: 'Terminal not yet supported for Orgo VMs' },
        { status: 501 }
      )
    }

    // Create terminal provider
    const provider = new SSHTerminalProvider(sshConfig)
    
    // Connect with timeout
    const connectTimeout = 30000 // 30 seconds
    const connectPromise = provider.connect()
    const timeoutPromise = new Promise<boolean>((_, reject) => 
      setTimeout(() => reject(new Error('SSH connection timeout after 30 seconds')), connectTimeout)
    )
    
    let connected: boolean
    try {
      connected = await Promise.race([connectPromise, timeoutPromise])
    } catch (timeoutError) {
      return NextResponse.json(
        { error: 'SSH connection timeout. The EC2 instance may be stopped or unreachable.' },
        { status: 504 }
      )
    }
    
    if (!connected) {
      return NextResponse.json(
        { error: 'Failed to connect to VM. Check if the EC2 instance is running and SSH port 22 is open.' },
        { status: 500 }
      )
    }
    

    // Initialize output buffer for this session
    sessionOutputBuffers.set(sessionId, [])

    // Start shell with output callback
    const shellStarted = await provider.startShell(
      (output) => {
        const buffer = sessionOutputBuffers.get(sessionId)
        if (buffer) {
          const outputStr = JSON.stringify(output)
          buffer.push(outputStr)
          
          // Keep buffer size manageable - limit both count and total size
          // Remove oldest entries if we exceed limits
          const MAX_BUFFER_ENTRIES = 500 // Reduced from 1000
          const MAX_BUFFER_SIZE = 5 * 1024 * 1024 // 5MB total buffer size
          
          // Calculate current buffer size
          let totalSize = buffer.reduce((sum, item) => sum + item.length, 0)
          
          // Remove oldest entries if we exceed limits
          while (
            (buffer.length > MAX_BUFFER_ENTRIES || totalSize > MAX_BUFFER_SIZE) &&
            buffer.length > 0
          ) {
            const removed = buffer.shift()
            if (removed) {
              totalSize -= removed.length
            }
          }
        }
      },
      cols,
      rows
    )

    if (!shellStarted) {
      await provider.disconnect()
      return NextResponse.json(
        { error: 'Failed to start shell' },
        { status: 500 }
      )
    }

    // Store session in manager
    sessionManager.addSession(sessionId, provider)

    return NextResponse.json({
      success: true,
      sessionId,
      message: 'Terminal session started',
    })

  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to connect terminal' },
      { status: 500 }
    )
  }
}

