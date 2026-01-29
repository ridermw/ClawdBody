import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { OrgoClient, generateComputerName } from '@/lib/orgo'
import { decrypt } from '@/lib/encryption'

/**
 * GET /api/vms - List all VMs for the current user
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const vms = await prisma.vM.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
    })

    // Also get the setup state to check for stored credentials
    const setupState = await prisma.setupState.findUnique({
      where: { userId: session.user.id },
      select: {
        orgoApiKey: true,
        awsAccessKeyId: true,
        awsSecretAccessKey: true,
        awsRegion: true,
        e2bApiKey: true,
        azureTenantId: true,
        azureClientId: true,
        azureClientSecret: true,
        azureSubscriptionId: true,
        azureRegion: true,
      },
    })

    // Return all VMs without auto-deleting
    // Note: We no longer auto-delete VMs based on Orgo API responses because:
    // 1. Newly created VMs might return 404 briefly while being provisioned
    // 2. Orgo API could be temporarily unavailable
    // 3. Users should manually delete VMs they no longer need
    const validVMs = vms

    return NextResponse.json({
      vms: validVMs,
      credentials: {
        hasOrgoApiKey: !!setupState?.orgoApiKey,
        hasAwsCredentials: !!(setupState?.awsAccessKeyId && setupState?.awsSecretAccessKey),
        awsRegion: setupState?.awsRegion || 'us-east-1',
        hasE2bApiKey: !!setupState?.e2bApiKey,
        hasAzureCredentials: !!(setupState?.azureTenantId && setupState?.azureClientId && setupState?.azureClientSecret && setupState?.azureSubscriptionId),
        azureRegion: setupState?.azureRegion || 'eastus',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list VMs' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/vms - Create a new VM
 * For Orgo VMs with provisionNow=true, this will immediately provision the VM
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const {
      name,
      provider,
      provisionNow, // If true, provision Orgo VM immediately
      // Orgo specific
      orgoProjectId,
      orgoProjectName,
      orgoRam,
      orgoCpu,
      // AWS specific
      awsInstanceType,
      awsRegion,
      // Azure specific
      azureVmSize,
      azureRegion,
      // E2B specific
      e2bTemplateId,
      e2bTimeout,
    } = body

    if (!name || !provider) {
      return NextResponse.json({ error: 'Name and provider are required' }, { status: 400 })
    }

    if (!['orgo', 'aws', 'azure', 'flyio', 'e2b'].includes(provider)) {
      return NextResponse.json({ error: 'Invalid provider' }, { status: 400 })
    }

    // For Orgo VMs with provisionNow, create the computer immediately
    let orgoComputerId: string | undefined
    let orgoComputerUrl: string | undefined
    let vmStatus = 'pending'

    if (provider === 'orgo' && provisionNow) {
      // Get the Orgo API key from setup state
      const setupState = await prisma.setupState.findUnique({
        where: { userId: session.user.id },
        select: { orgoApiKey: true },
      })

      if (!setupState?.orgoApiKey) {
        return NextResponse.json({ error: 'Orgo API key not configured' }, { status: 400 })
      }

      // Decrypt the stored API key
      const orgoClient = new OrgoClient(decrypt(setupState.orgoApiKey))
      const computerName = generateComputerName()

      try {
        // Call Orgo API to create the computer
        const computer = await orgoClient.createComputer(orgoProjectId, computerName, {
          os: 'linux',
          ram: orgoRam as 1 | 2 | 4 | 8 | 16 | 32 | 64,
          cpu: orgoCpu as 1 | 2 | 4 | 8 | 16,
        })

        orgoComputerId = computer.id
        orgoComputerUrl = computer.url
        vmStatus = 'running'
        
      } catch (orgoError: any) {
        
        // Parse the error response from Orgo
        let errorMessage = orgoError.message || 'Failed to provision VM'
        let upgradeTier: string | undefined
        
        // Check if it's a plan limitation error
        if (errorMessage.includes('plan allows') || errorMessage.includes('requires')) {
          // Return the error with upgrade info
          return NextResponse.json({
            error: errorMessage,
            upgradeTier: 'pro', // Or parse from response if available
            needsUpgrade: true,
          }, { status: 400 })
        }
        
        return NextResponse.json({ error: errorMessage }, { status: 400 })
      }
    }

    // Create the VM record
    const vm = await prisma.vM.create({
      data: {
        userId: session.user.id,
        name,
        provider,
        status: vmStatus,
        vmCreated: provider === 'orgo' && provisionNow && !!orgoComputerId,
        // Orgo specific
        orgoProjectId,
        orgoProjectName,
        orgoRam,
        orgoCpu,
        orgoComputerId,
        orgoComputerUrl,
        // AWS specific
        awsInstanceType,
        awsRegion,
        // Azure specific
        azureVmSize,
        azureRegion,
        // E2B specific
        e2bTemplateId,
        e2bTimeout,
      },
    })

    return NextResponse.json({ success: true, vm })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create VM' },
      { status: 500 }
    )
  }
}
