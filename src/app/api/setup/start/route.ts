import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { OrgoClient, generateComputerName } from '@/lib/orgo'
import { AWSClient, generateInstanceName } from '@/lib/aws'
import { E2BClient, generateSandboxName } from '@/lib/e2b'
import { AzureClient } from '@/lib/azure'
import { VMSetup } from '@/lib/vm-setup'
import { AWSVMSetup } from '@/lib/aws-vm-setup'
import { E2BVMSetup } from '@/lib/e2b-vm-setup'
import { AzureVMSetup } from '@/lib/azure-vm-setup'
import { encrypt, decrypt } from '@/lib/encryption'
// Import type from Prisma client for type checking
import type { SetupState } from '@prisma/client'

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { claudeApiKey, telegramBotToken, telegramUserId, vmId } = await request.json()

    if (!claudeApiKey) {
      return NextResponse.json({ error: 'Claude API key is required' }, { status: 400 })
    }

    // Get existing setup state to retrieve user's provider config
    let setupState = await prisma.setupState.findUnique({
      where: { userId: session.user.id },
    })

    // If vmId is provided, get the VM to determine provider
    let vm = null
    if (vmId) {
      vm = await prisma.vM.findFirst({
        where: { id: vmId, userId: session.user.id },
      })
      if (!vm) {
        return NextResponse.json({ error: 'VM not found' }, { status: 404 })
      }
    }

    // Use VM provider if available, otherwise fall back to setupState
    const vmProvider = vm?.provider || setupState?.vmProvider || 'orgo'

    // Validate provider-specific configuration
    if (vmProvider === 'orgo') {
      const orgoApiKey = setupState?.orgoApiKey
      if (!orgoApiKey) {
        return NextResponse.json({
          error: 'Orgo API key not configured. Please go back and configure your Orgo API key.'
        }, { status: 400 })
      }
    } else if (vmProvider === 'aws') {
      // Type assertion to access AWS fields (TypeScript may have stale types cached)
      const awsState = setupState as SetupState & { awsAccessKeyId?: string; awsSecretAccessKey?: string }
      const awsAccessKeyId = awsState?.awsAccessKeyId
      const awsSecretAccessKey = awsState?.awsSecretAccessKey
      if (!awsAccessKeyId || !awsSecretAccessKey) {
        return NextResponse.json({
          error: 'AWS credentials not configured. Please go back and configure your AWS credentials.'
        }, { status: 400 })
      }
    } else if (vmProvider === 'e2b') {
      // Type assertion to access E2B fields
      const e2bState = setupState as SetupState & { e2bApiKey?: string }
      const e2bApiKey = e2bState?.e2bApiKey
      if (!e2bApiKey) {
        return NextResponse.json({
          error: 'E2B API key not configured. Please go back and configure your E2B API key.'
        }, { status: 400 })
      }
    } else if (vmProvider === 'azure') {
      // Type assertion to access Azure fields
      const azureState = setupState as SetupState & {
        azureTenantId?: string
        azureClientId?: string
        azureClientSecret?: string
        azureSubscriptionId?: string
      }
      const azureTenantId = azureState?.azureTenantId
      const azureClientId = azureState?.azureClientId
      const azureClientSecret = azureState?.azureClientSecret
      const azureSubscriptionId = azureState?.azureSubscriptionId
      if (!azureTenantId || !azureClientId || !azureClientSecret || !azureSubscriptionId) {
        return NextResponse.json({
          error: 'Azure credentials not configured. Please go back and configure your Azure credentials.'
        }, { status: 400 })
      }
    } else {
      return NextResponse.json({
        error: `Unsupported VM provider: ${vmProvider}`
      }, { status: 400 })
    }

    if (!setupState) {
      setupState = await prisma.setupState.create({
        data: {
          userId: session.user.id,
          claudeApiKey: encrypt(claudeApiKey),
          status: 'provisioning',
        },
      })
    } else {
      // Update existing state and reset all progress flags for a fresh start
      setupState = await prisma.setupState.update({
        where: { id: setupState.id },
        data: {
          claudeApiKey: encrypt(claudeApiKey),
          status: 'provisioning',
          errorMessage: null,
          vmCreated: false,
          clawdbotInstalled: false,
          telegramConfigured: false,
          gatewayStarted: false,
        },
      })
    }

    // If vmId is provided, also update the VM model status
    if (vmId && vm) {
      await prisma.vM.update({
        where: { id: vmId },
        data: {
          status: 'provisioning',
          errorMessage: null,
          vmCreated: false,
          clawdbotInstalled: false,
          gatewayStarted: false,
        },
      })
    }

    // Start async setup process based on provider
    // Note: claudeApiKey is passed as-is (plaintext from request), but provider keys are decrypted from DB
    if (vmProvider === 'aws') {
      // Type assertion to access AWS fields
      const awsState = setupState as SetupState & {
        awsAccessKeyId?: string
        awsSecretAccessKey?: string
        awsRegion?: string
        awsInstanceType?: string
      }
      // Decrypt stored AWS credentials
      const decryptedAccessKeyId = decrypt(awsState.awsAccessKeyId!)
      const decryptedSecretAccessKey = decrypt(awsState.awsSecretAccessKey!)
      runAWSSetupProcess(
        session.user.id,
        claudeApiKey,
        decryptedAccessKeyId,
        decryptedSecretAccessKey,
        awsState.awsRegion || 'us-east-1',
        vm?.awsInstanceType || awsState.awsInstanceType || 't3.micro',
        telegramBotToken,
        telegramUserId,
        vmId // Pass vmId
      ).catch(() => { })
    } else if (vmProvider === 'e2b') {
      // Type assertion to access E2B fields
      const e2bState = setupState as SetupState & { e2bApiKey?: string }
      // Decrypt stored E2B API key
      const decryptedE2bApiKey = decrypt(e2bState.e2bApiKey!)
      runE2BSetupProcess(
        session.user.id,
        claudeApiKey,
        decryptedE2bApiKey,
        vm?.e2bTemplateId || 'base',
        vm?.e2bTimeout || 3600,
        telegramBotToken,
        telegramUserId,
        vmId // Pass vmId
      ).catch(() => { })
    } else if (vmProvider === 'azure') {
      // Type assertion to access Azure fields
      const azureState = setupState as SetupState & {
        azureTenantId?: string
        azureClientId?: string
        azureClientSecret?: string
        azureSubscriptionId?: string
        azureRegion?: string
        azureVmSize?: string
      }
      // Decrypt stored Azure credentials
      const decryptedTenantId = decrypt(azureState.azureTenantId!)
      const decryptedClientId = decrypt(azureState.azureClientId!)
      const decryptedClientSecret = decrypt(azureState.azureClientSecret!)
      const decryptedSubscriptionId = decrypt(azureState.azureSubscriptionId!)
      runAzureSetupProcess(
        session.user.id,
        claudeApiKey,
        decryptedTenantId,
        decryptedClientId,
        decryptedClientSecret,
        decryptedSubscriptionId,
        vm?.azureRegion || azureState.azureRegion || 'eastus',
        vm?.azureVmSize || azureState.azureVmSize || 'Standard_B2s',
        telegramBotToken,
        telegramUserId,
        vmId // Pass vmId
      ).catch(() => { })
    } else {
      // Type assertion to access Orgo-specific fields (TypeScript may have stale types cached)
      const orgoVM = vm as (typeof vm & { orgoRam?: number; orgoCpu?: number }) | null
      // Decrypt stored Orgo API key
      const decryptedOrgoApiKey = decrypt(setupState.orgoApiKey!)
      runSetupProcess(
        session.user.id,
        claudeApiKey,
        decryptedOrgoApiKey,
        vm?.orgoProjectName || setupState.orgoProjectName || 'claude-brain',
        telegramBotToken,
        telegramUserId,
        vmId, // Pass vmId
        orgoVM?.orgoRam || 4, // Pass RAM (default 4 GB)
        orgoVM?.orgoCpu || 2  // Pass CPU (default 2 cores)
      ).catch(() => { })
    }

    return NextResponse.json({
      success: true,
      message: 'Setup started',
      setupId: setupState.id,
      provider: vmProvider,
    })

  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to start setup' },
      { status: 500 }
    )
  }
}

async function runSetupProcess(
  userId: string,
  claudeApiKey: string,
  orgoApiKey: string,
  projectName: string,
  telegramBotToken?: string,
  telegramUserId?: string,
  vmId?: string,
  orgoRam: number = 4,
  orgoCpu: number = 2
) {
  const updateStatus = async (updates: Partial<{
    status: string
    vmCreated: boolean
    clawdbotInstalled: boolean
    telegramConfigured: boolean
    gatewayStarted: boolean
    orgoProjectId: string
    orgoComputerId: string
    orgoComputerUrl: string
    vmStatus: string
    errorMessage: string
  }>) => {
    // Update SetupState
    await prisma.setupState.update({
      where: { userId },
      data: updates,
    })

    // Also update VM model if vmId is provided
    if (vmId) {
      const vmUpdates: Record<string, unknown> = {}
      if (updates.status !== undefined) vmUpdates.status = updates.status
      if (updates.vmCreated !== undefined) vmUpdates.vmCreated = updates.vmCreated
      if (updates.clawdbotInstalled !== undefined) vmUpdates.clawdbotInstalled = updates.clawdbotInstalled
      if (updates.telegramConfigured !== undefined) vmUpdates.telegramConfigured = updates.telegramConfigured
      if (updates.gatewayStarted !== undefined) vmUpdates.gatewayStarted = updates.gatewayStarted
      if (updates.orgoProjectId !== undefined) vmUpdates.orgoProjectId = updates.orgoProjectId
      if (updates.orgoComputerId !== undefined) vmUpdates.orgoComputerId = updates.orgoComputerId
      if (updates.orgoComputerUrl !== undefined) vmUpdates.orgoComputerUrl = updates.orgoComputerUrl
      if (updates.errorMessage !== undefined) vmUpdates.errorMessage = updates.errorMessage

      if (Object.keys(vmUpdates).length > 0) {
        await prisma.vM.update({
          where: { id: vmId },
          data: vmUpdates,
        })
      }
    }
  }

  try {
    // Get setup state
    const setupState = await prisma.setupState.findUnique({
      where: { userId },
    })

    // Get the VM record if vmId is provided (to check if VM is already created)
    let existingVM = null
    if (vmId) {
      existingVM = await prisma.vM.findUnique({
        where: { id: vmId },
      })
    }

    const user = await prisma.user.findUnique({ where: { id: userId } })
    const orgoClient = new OrgoClient(orgoApiKey)

    let computer: any
    let project: { id: string; name: string }

    // Check if VM is already provisioned (created during "Add VM" step)
    if (existingVM?.vmCreated && existingVM?.orgoComputerId) {
      // Use the existing computer
      computer = {
        id: existingVM.orgoComputerId,
        url: existingVM.orgoComputerUrl,
      }
      project = {
        id: existingVM.orgoProjectId || '',
        name: existingVM.orgoProjectName || projectName,
      }

      await updateStatus({
        status: 'provisioning',
        orgoProjectId: project.id,
        orgoComputerId: computer.id,
        orgoComputerUrl: computer.url,
        vmCreated: true,
        vmStatus: 'running',
      })
    } else {
      // 1. Create Orgo project and VM
      await updateStatus({ status: 'provisioning' })

      // First, find the project by name to get its ID, or create if it doesn't exist
      const projects = await orgoClient.listProjects()
      project = projects.find(p => p.name === projectName) || { id: '', name: projectName }

      if (!project.id) {
        // Project doesn't exist - create it
        try {
          project = await orgoClient.createProject(projectName)
        } catch (createErr: any) {
          // If project creation fails, it might be because the API doesn't support explicit creation
          // In that case, some APIs create projects implicitly - we'll try with an empty ID
          project = { id: '', name: projectName }
        }
      }

      await updateStatus({ orgoProjectId: project.id || '' })

      const computerName = generateComputerName()
      // Create computer using project ID (POST /computers with project_id in body)
      // Retry logic for computer creation (may timeout but still succeed)
      let retries = 3
      let lastError: Error | null = null

      while (retries > 0) {
        try {
          // If project ID is empty, try using project name instead (some APIs support this)
          const projectIdOrName = project.id || project.name
          computer = await orgoClient.createComputer(projectIdOrName, computerName, {
            os: 'linux',
            ram: orgoRam as 1 | 2 | 4 | 8 | 16 | 32 | 64,
            cpu: orgoCpu as 1 | 2 | 4 | 8 | 16,
          })

          // If we didn't have a project ID, update it from the created computer's project info
          if (!project.id && computer.project_name) {
            // Try to get the updated project list to find the ID
            const updatedProjects = await orgoClient.listProjects()
            const createdProject = updatedProjects.find(p => p.name === computer.project_name || p.name === projectName)
            if (createdProject) {
              project = createdProject
              await updateStatus({ orgoProjectId: createdProject.id })
            }
          }

          break // Success, exit retry loop
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))

          // If it's a timeout, the computer might still be created - check if it exists
          if (lastError.message.includes('timed out') || lastError.message.includes('ETIMEDOUT')) {
            try {
              // Wait a bit and check if computer exists
              await new Promise(resolve => setTimeout(resolve, 5000))
              const computers = await orgoClient.listComputers(project.name || projectName)
              const existingComputer = computers.find(c => c.name === computerName)
              if (existingComputer) {
                computer = existingComputer
                break
              }
            } catch (checkError) {
              // Could not verify computer creation
            }
          }

          retries--
          if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 3000)) // Wait before retry
          }
        }
      }

      if (!computer) {
        throw lastError || new Error('Failed to create computer after retries')
      }

      await updateStatus({
        orgoComputerId: computer.id,
        orgoComputerUrl: computer.url,
        vmStatus: 'creating',
      })
    }

    // Wait a bit for VM to initialize before trying to configure it
    await new Promise(resolve => setTimeout(resolve, 10000)) // Wait 10 seconds

    await updateStatus({ vmCreated: true, vmStatus: 'running' })

    // 2. Configure VM
    await updateStatus({ status: 'configuring_vm' })

    const vmSetup = new VMSetup(orgoClient, computer.id, () => {
      // Progress callback
    })

    // Install Python and essential tools
    const pythonSuccess = await vmSetup.installPython()
    if (!pythonSuccess) {
      throw new Error('Failed to install Python and essential tools on VM')
    }

    // Install Orgo and Anthropic Python SDKs for computer use
    const sdkSuccess = await vmSetup.installOrgoPythonSDK()
    if (!sdkSuccess) {
      // SDK installation had issues, continuing...
    }

    // Install Clawdbot (NVM + Node.js 22 + Clawdbot)
    const clawdbotResult = await vmSetup.installClawdbot()
    if (!clawdbotResult.success) {
      throw new Error('Failed to install Clawdbot')
    }
    await updateStatus({ clawdbotInstalled: true })

    // Configure Clawdbot with Telegram if token is provided (from UI or env)
    const finalTelegramToken = telegramBotToken || process.env.TELEGRAM_BOT_TOKEN
    const finalTelegramUserId = telegramUserId || process.env.TELEGRAM_USER_ID

    if (finalTelegramToken) {
      const telegramSuccess = await vmSetup.setupClawdbotTelegram({
        claudeApiKey,
        telegramBotToken: finalTelegramToken,
        telegramUserId: finalTelegramUserId,
        clawdbotVersion: clawdbotResult.version,
        heartbeatIntervalMinutes: 30,
        userId,
        apiBaseUrl: process.env.NEXTAUTH_URL || 'http://localhost:3000',
      })
      await updateStatus({ telegramConfigured: telegramSuccess })

      if (telegramSuccess) {
        const gatewaySuccess = await vmSetup.startClawdbotGateway(claudeApiKey, finalTelegramToken)
        await updateStatus({ gatewayStarted: gatewaySuccess })
      }
    } else {
      // Just store Claude API key if no Telegram
      await vmSetup.storeClaudeKey(claudeApiKey)
    }

    // Setup complete!
    await updateStatus({ status: 'ready' })

  } catch (error) {
    await updateStatus({
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Unknown error occurred',
    })
  }
}


/**
 * AWS EC2 Setup Process
 */
async function runAWSSetupProcess(
  userId: string,
  claudeApiKey: string,
  awsAccessKeyId: string,
  awsSecretAccessKey: string,
  awsRegion: string,
  awsInstanceType: string,
  telegramBotToken?: string,
  telegramUserId?: string,
  vmId?: string
) {
  const updateStatus = async (updates: Partial<{
    status: string
    vmCreated: boolean
    clawdbotInstalled: boolean
    telegramConfigured: boolean
    gatewayStarted: boolean
    awsInstanceId: string
    awsInstanceName: string
    awsPublicIp: string
    awsPrivateKey: string
    vmStatus: string
    errorMessage: string
  }>) => {
    // Update SetupState
    await prisma.setupState.update({
      where: { userId },
      data: updates,
    })

    // Also update VM model if vmId is provided
    if (vmId) {
      const vmUpdates: Record<string, unknown> = {}
      if (updates.status !== undefined) vmUpdates.status = updates.status
      if (updates.vmCreated !== undefined) vmUpdates.vmCreated = updates.vmCreated
      if (updates.clawdbotInstalled !== undefined) vmUpdates.clawdbotInstalled = updates.clawdbotInstalled
      if (updates.telegramConfigured !== undefined) vmUpdates.telegramConfigured = updates.telegramConfigured
      if (updates.gatewayStarted !== undefined) vmUpdates.gatewayStarted = updates.gatewayStarted
      if (updates.awsInstanceId !== undefined) vmUpdates.awsInstanceId = updates.awsInstanceId
      if (updates.awsInstanceName !== undefined) vmUpdates.awsInstanceName = updates.awsInstanceName
      if (updates.awsPublicIp !== undefined) vmUpdates.awsPublicIp = updates.awsPublicIp
      if (updates.awsPrivateKey !== undefined) vmUpdates.awsPrivateKey = updates.awsPrivateKey
      if (updates.errorMessage !== undefined) vmUpdates.errorMessage = updates.errorMessage

      if (Object.keys(vmUpdates).length > 0) {
        await prisma.vM.update({
          where: { id: vmId },
          data: vmUpdates,
        })
      }
    }
  }

  let awsVMSetup: AWSVMSetup | null = null

  try {
    // Get setup state
    const setupState = await prisma.setupState.findUnique({
      where: { userId },
    })

    const user = await prisma.user.findUnique({ where: { id: userId } })
    const awsClient = new AWSClient({
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey,
      region: awsRegion,
    })

    // 1. Create AWS EC2 Instance
    await updateStatus({ status: 'provisioning', vmStatus: 'creating' })

    const instanceName = generateInstanceName()
    const { instance, privateKey } = await awsClient.createInstance({
      name: instanceName,
      instanceType: awsInstanceType,
      region: awsRegion,
    })

    await updateStatus({
      awsInstanceId: instance.id,
      awsInstanceName: instance.name,
      awsPublicIp: instance.publicIp,
      awsPrivateKey: encrypt(privateKey),
      vmStatus: 'starting',
    })

    // Wait for instance to be running
    await new Promise(resolve => setTimeout(resolve, 30000)) // Wait 30 seconds for instance to fully boot

    // Get updated instance info with public IP
    const updatedInstance = await awsClient.getInstance(instance.id)
    await updateStatus({
      awsPublicIp: updatedInstance.publicIp,
      vmCreated: true,
      vmStatus: 'running',
    })

    // 2. Configure VM
    await updateStatus({ status: 'configuring_vm' })

    awsVMSetup = new AWSVMSetup(
      awsClient,
      instance.id,
      privateKey,
      updatedInstance.publicIp,
      () => {
        // Progress callback
      }
    )

    // Install Python and essential tools
    const pythonSuccess = await awsVMSetup.installPython()
    if (!pythonSuccess) {
      throw new Error('Failed to install Python and essential tools on VM')
    }

    // Install Anthropic SDKs
    await awsVMSetup.installAnthropicSDK()

    // Install Clawdbot
    const clawdbotResult = await awsVMSetup.installClawdbot()
    if (!clawdbotResult.success) {
      throw new Error('Failed to install Clawdbot')
    }
    await updateStatus({ clawdbotInstalled: true })

    // Configure Clawdbot with Telegram if token is provided
    const finalTelegramToken = telegramBotToken || process.env.TELEGRAM_BOT_TOKEN
    const finalTelegramUserId = telegramUserId || process.env.TELEGRAM_USER_ID

    if (finalTelegramToken) {
      const telegramSuccess = await awsVMSetup.setupClawdbotTelegram({
        claudeApiKey,
        telegramBotToken: finalTelegramToken,
        telegramUserId: finalTelegramUserId,
        clawdbotVersion: clawdbotResult.version,
        heartbeatIntervalMinutes: 30,
        userId,
        apiBaseUrl: process.env.NEXTAUTH_URL || 'http://localhost:3000',
      })
      await updateStatus({ telegramConfigured: telegramSuccess })

      if (telegramSuccess) {
        const gatewaySuccess = await awsVMSetup.startClawdbotGateway(claudeApiKey, finalTelegramToken)
        await updateStatus({ gatewayStarted: gatewaySuccess })
      }
    } else {
      await awsVMSetup.storeClaudeKey(claudeApiKey)
    }

    // Setup complete!
    await updateStatus({ status: 'ready' })

  } catch (error: any) {

    // Check for Free Tier restriction error
    const errorMessage = error?.message || error?.Error?.Message || String(error)
    const isFreeTierError = errorMessage.includes('not eligible for Free Tier') ||
      errorMessage.includes('Free Tier') ||
      (error?.Code === 'InvalidParameterCombination' && errorMessage.includes('Free Tier'))

    if (isFreeTierError) {
      // This is a billing/payment issue, not a technical error
      await updateStatus({
        status: 'requires_payment',
        errorMessage: `BILLING_REQUIRED:${awsInstanceType}`, // Pass the instance type for the UI
      })
    } else {
      await updateStatus({
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error occurred',
      })
    }
  } finally {
    // Cleanup SSH connection
    if (awsVMSetup) {
      awsVMSetup.cleanup()
    }
  }
}

/**
 * Azure VM Setup Process
 */
async function runAzureSetupProcess(
  userId: string,
  claudeApiKey: string,
  azureTenantId: string,
  azureClientId: string,
  azureClientSecret: string,
  azureSubscriptionId: string,
  azureRegion: string,
  azureVmSize: string,
  telegramBotToken?: string,
  telegramUserId?: string,
  vmId?: string
) {
  const updateStatus = async (updates: Partial<{
    status: string
    vmCreated: boolean
    clawdbotInstalled: boolean
    telegramConfigured: boolean
    gatewayStarted: boolean
    azureVmId: string
    azureVmName: string
    azureResourceGroup: string
    azurePublicIp: string
    azurePrivateKey: string
    azureAdminPassword: string
    vmStatus: string
    errorMessage: string
  }>) => {
    // Update SetupState with only fields that exist in the model
    const setupStateUpdates: Record<string, unknown> = {}
    if (updates.status !== undefined) setupStateUpdates.status = updates.status
    if (updates.vmCreated !== undefined) setupStateUpdates.vmCreated = updates.vmCreated
    if (updates.clawdbotInstalled !== undefined) setupStateUpdates.clawdbotInstalled = updates.clawdbotInstalled
    if (updates.telegramConfigured !== undefined) setupStateUpdates.telegramConfigured = updates.telegramConfigured
    if (updates.gatewayStarted !== undefined) setupStateUpdates.gatewayStarted = updates.gatewayStarted
    if (updates.errorMessage !== undefined) setupStateUpdates.errorMessage = updates.errorMessage
    if (updates.vmStatus !== undefined) setupStateUpdates.vmStatus = updates.vmStatus

    if (Object.keys(setupStateUpdates).length > 0) {
      await prisma.setupState.update({
        where: { userId },
        data: setupStateUpdates,
      })
    }

    // Update VM model with Azure-specific fields if vmId is provided
    if (vmId) {
      const vmUpdates: Record<string, unknown> = {}
      if (updates.status !== undefined) vmUpdates.status = updates.status
      if (updates.vmCreated !== undefined) vmUpdates.vmCreated = updates.vmCreated
      if (updates.clawdbotInstalled !== undefined) vmUpdates.clawdbotInstalled = updates.clawdbotInstalled
      if (updates.telegramConfigured !== undefined) vmUpdates.telegramConfigured = updates.telegramConfigured
      if (updates.gatewayStarted !== undefined) vmUpdates.gatewayStarted = updates.gatewayStarted
      if (updates.azureVmId !== undefined) vmUpdates.azureVmId = updates.azureVmId
      if (updates.azureVmName !== undefined) vmUpdates.azureVmName = updates.azureVmName
      if (updates.azureResourceGroup !== undefined) vmUpdates.azureResourceGroup = updates.azureResourceGroup
      if (updates.azurePublicIp !== undefined) vmUpdates.azurePublicIp = updates.azurePublicIp
      if (updates.azurePrivateKey !== undefined) vmUpdates.azurePrivateKey = updates.azurePrivateKey
      if (updates.azureAdminPassword !== undefined) vmUpdates.azureAdminPassword = updates.azureAdminPassword
      if (updates.errorMessage !== undefined) vmUpdates.errorMessage = updates.errorMessage

      if (Object.keys(vmUpdates).length > 0) {
        await prisma.vM.update({
          where: { id: vmId },
          data: vmUpdates,
        })
      }
    }
  }

  let azureVMSetup: AzureVMSetup | null = null

  try {
    const azureClient = new AzureClient({
      tenantId: azureTenantId,
      clientId: azureClientId,
      clientSecret: azureClientSecret,
      subscriptionId: azureSubscriptionId,
      region: azureRegion,
    })

    // 1. Create Azure VM
    await updateStatus({ status: 'provisioning', vmStatus: 'creating' })

    const vmName = `Azure-VM-${Date.now()}`
    const { instance, privateKey, adminPassword } = await azureClient.createInstance({
      name: vmName,
      vmSize: azureVmSize,
      region: azureRegion,
    })

    await updateStatus({
      azureVmId: instance.id,
      azureVmName: instance.name,
      azureResourceGroup: instance.resourceGroup!,
      azurePublicIp: instance.publicIp!,
      azurePrivateKey: encrypt(privateKey),
      azureAdminPassword: encrypt(adminPassword),
      vmStatus: 'starting',
    })

    // Wait for VM to be fully ready
    await new Promise(resolve => setTimeout(resolve, 60000)) // Wait 60 seconds for VM to fully boot

    await updateStatus({
      vmCreated: true,
      vmStatus: 'running',
    })

    // 2. Configure VM
    await updateStatus({ status: 'configuring_vm' })

    azureVMSetup = new AzureVMSetup(
      azureClient,
      instance.resourceGroup!,
      instance.name,
      privateKey,
      instance.publicIp,
      () => {
        // Progress callback
      }
    )

    // Install Python and essential tools
    const pythonSuccess = await azureVMSetup.installPython()
    if (!pythonSuccess) {
      throw new Error('Failed to install Python and essential tools on VM')
    }

    // Install Anthropic SDKs
    await azureVMSetup.installAnthropicSDK()

    // Install Clawdbot
    await azureVMSetup.installClawdbot()
    await updateStatus({ clawdbotInstalled: true })

    // 3. Configure Telegram (if provided)
    if (telegramBotToken && telegramUserId) {
      const telegramSuccess = await azureVMSetup.configureTelegram({
        telegramBotToken,
        telegramUserId,
        userId,
        apiBaseUrl: process.env.NEXTAUTH_URL || 'http://localhost:3000',
      })
      await updateStatus({ telegramConfigured: telegramSuccess })

      if (telegramSuccess) {
        const gatewaySuccess = await azureVMSetup.startClawdbotGateway(claudeApiKey, telegramBotToken)
        await updateStatus({ gatewayStarted: gatewaySuccess })
      }
    } else {
      // Just store Claude API key if no Telegram
      await azureVMSetup.storeClaudeKey(claudeApiKey)
    }

    // Setup complete!
    await updateStatus({ status: 'ready' })

  } catch (error) {
    await updateStatus({
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Unknown error occurred',
    })
  } finally {
    // Cleanup SSH connection
    if (azureVMSetup) {
      azureVMSetup.cleanup()
    }
  }
}

/**
 * E2B Sandbox Setup Process
 */
async function runE2BSetupProcess(
  userId: string,
  claudeApiKey: string,
  e2bApiKey: string,
  templateId: string,
  timeout: number,
  telegramBotToken?: string,
  telegramUserId?: string,
  vmId?: string
) {
  const updateStatus = async (updates: Partial<{
    status: string
    vmCreated: boolean
    clawdbotInstalled: boolean
    telegramConfigured: boolean
    gatewayStarted: boolean
    vmStatus: string
    errorMessage: string
  }>) => {
    // Update SetupState
    await prisma.setupState.update({
      where: { userId },
      data: updates,
    })

    // Also update VM model if vmId is provided
    if (vmId) {
      const vmUpdates: Record<string, unknown> = {}
      if (updates.status !== undefined) vmUpdates.status = updates.status
      if (updates.vmCreated !== undefined) vmUpdates.vmCreated = updates.vmCreated
      if (updates.clawdbotInstalled !== undefined) vmUpdates.clawdbotInstalled = updates.clawdbotInstalled
      if (updates.telegramConfigured !== undefined) vmUpdates.telegramConfigured = updates.telegramConfigured
      if (updates.gatewayStarted !== undefined) vmUpdates.gatewayStarted = updates.gatewayStarted
      if (updates.errorMessage !== undefined) vmUpdates.errorMessage = updates.errorMessage

      if (Object.keys(vmUpdates).length > 0) {
        await prisma.vM.update({
          where: { id: vmId },
          data: vmUpdates,
        })
      }
    }
  }

  let sandbox: any = null

  try {
    // Get setup state
    const setupState = await prisma.setupState.findUnique({
      where: { userId },
    })

    const user = await prisma.user.findUnique({ where: { id: userId } })
    const e2bClient = new E2BClient(e2bApiKey)

    // 1. Create E2B Sandbox
    await updateStatus({ status: 'provisioning', vmStatus: 'creating' })

    const sandboxName = generateSandboxName()
    const { sandbox: createdSandbox, sandboxId } = await e2bClient.createSandbox({
      templateId,
      timeout,
      metadata: { name: sandboxName, userId },
    })
    sandbox = createdSandbox

    // Update VM with sandbox ID
    if (vmId) {
      await prisma.vM.update({
        where: { id: vmId },
        data: { e2bSandboxId: sandboxId },
      })
    }

    await updateStatus({
      vmCreated: true,
      vmStatus: 'running',
    })

    // 2. Configure sandbox
    await updateStatus({ status: 'configuring_vm' })

    const e2bVMSetup = new E2BVMSetup(
      e2bClient,
      sandbox,
      sandboxId,
      () => {
        // Progress callback
      }
    )

    // Install essentials (E2B comes with Python pre-installed)
    await e2bVMSetup.installEssentials()

    // Install Clawdbot
    const clawdbotResult = await e2bVMSetup.installClawdbot()
    if (!clawdbotResult.success) {
      throw new Error('Failed to install Clawdbot')
    }
    await updateStatus({ clawdbotInstalled: true })

    // Configure Clawdbot with Telegram if token is provided
    const finalTelegramToken = telegramBotToken || process.env.TELEGRAM_BOT_TOKEN
    const finalTelegramUserId = telegramUserId || process.env.TELEGRAM_USER_ID

    if (finalTelegramToken) {
      const telegramSuccess = await e2bVMSetup.setupClawdbotTelegram({
        claudeApiKey,
        telegramBotToken: finalTelegramToken,
        telegramUserId: finalTelegramUserId,
        clawdbotVersion: clawdbotResult.version,
        heartbeatIntervalMinutes: 30,
        userId,
        apiBaseUrl: process.env.NEXTAUTH_URL || 'http://localhost:3000',
      })
      await updateStatus({ telegramConfigured: telegramSuccess })

      if (telegramSuccess) {
        const gatewaySuccess = await e2bVMSetup.startClawdbotGateway(claudeApiKey, finalTelegramToken)
        await updateStatus({ gatewayStarted: gatewaySuccess })
      }
    } else {
      await e2bVMSetup.storeClaudeKey(claudeApiKey)
    }

    // Setup complete!
    await updateStatus({ status: 'ready' })

  } catch (error) {
    await updateStatus({
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Unknown error occurred',
    })

    // Try to clean up sandbox on failure
    if (sandbox) {
      try {
        const e2bClient = new E2BClient(e2bApiKey)
        await e2bClient.killSandbox(sandbox)
      } catch (cleanupError) {
        // Failed to clean up sandbox
      }
    }
  }
}