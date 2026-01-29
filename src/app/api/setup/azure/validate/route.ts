import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { AzureClient, AZURE_REGIONS, AZURE_VM_SIZES } from '@/lib/azure'
import { encrypt, decrypt } from '@/lib/encryption'

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { tenantId, clientId, clientSecret, subscriptionId, region, useStored } = await request.json()

    let tenant = tenantId
    let client = clientId
    let secret = clientSecret
    let subscription = subscriptionId
    let regionToUse = region || 'eastus'

    // If useStored is true, fetch the stored credentials
    if (useStored) {
      const setupState = await prisma.setupState.findUnique({
        where: { userId: session.user.id },
        select: {
          azureTenantId: true,
          azureClientId: true,
          azureClientSecret: true,
          azureSubscriptionId: true,
          azureRegion: true,
        },
      })

      if (!setupState?.azureTenantId || !setupState?.azureClientId ||
          !setupState?.azureClientSecret || !setupState?.azureSubscriptionId) {
        return NextResponse.json({ error: 'No stored Azure credentials found' }, { status: 400 })
      }

      // Decrypt stored credentials
      tenant = decrypt(setupState.azureTenantId)
      client = decrypt(setupState.azureClientId)
      secret = decrypt(setupState.azureClientSecret)
      subscription = decrypt(setupState.azureSubscriptionId)
      regionToUse = setupState.azureRegion || 'eastus'
    }

    if (!tenant || !client || !secret || !subscription) {
      return NextResponse.json({ error: 'Azure credentials are required' }, { status: 400 })
    }

    // Initialize Azure client
    const azureClient = new AzureClient({
      tenantId: tenant,
      clientId: client,
      clientSecret: secret,
      subscriptionId: subscription,
      region: regionToUse,
    })

    // Validate credentials
    const validation = await azureClient.validateCredentials()

    if (!validation.valid) {
      return NextResponse.json({
        error: validation.error || 'Invalid Azure credentials'
      }, { status: 400 })
    }

    // List existing Clawdbot VMs
    const instances = await azureClient.listInstances()

    // Store credentials in setup state (only if new credentials were provided) - encrypted
    if (!useStored) {
      await prisma.setupState.upsert({
        where: { userId: session.user.id },
        update: {
          azureTenantId: encrypt(tenant),
          azureClientId: encrypt(client),
          azureClientSecret: encrypt(secret),
          azureSubscriptionId: encrypt(subscription),
          azureRegion: regionToUse,
        },
        create: {
          userId: session.user.id,
          azureTenantId: encrypt(tenant),
          azureClientId: encrypt(client),
          azureClientSecret: encrypt(secret),
          azureSubscriptionId: encrypt(subscription),
          azureRegion: regionToUse,
          status: 'pending',
        },
      })
    }

    return NextResponse.json({
      success: true,
      message: 'Azure credentials validated successfully',
      instances,
      regions: AZURE_REGIONS,
      vmSizes: AZURE_VM_SIZES,
    })

  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to validate Azure credentials' },
      { status: 500 }
    )
  }
}
