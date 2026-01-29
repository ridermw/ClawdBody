/**
 * Azure VM Client
 * Handles VM provisioning and management on Azure
 * Allows programmatic setup without users needing to touch Azure Portal
 */

import { ComputeManagementClient } from '@azure/arm-compute'
import { NetworkManagementClient } from '@azure/arm-network'
import { ResourceManagementClient } from '@azure/arm-resources'
import { ClientSecretCredential } from '@azure/identity'

const DEFAULT_REGION = 'eastus'

// Ubuntu 22.04 LTS images for Azure (Canonical URN format)
const UBUNTU_IMAGE = {
  publisher: 'Canonical',
  offer: '0001-com-ubuntu-server-jammy',
  sku: '22_04-lts-gen2',
  version: 'latest',
}

export interface AzureCredentials {
  tenantId: string
  clientId: string
  clientSecret: string
  subscriptionId: string
  region?: string
}

export interface AzureInstance {
  id: string
  name: string
  publicIp?: string
  privateIp?: string
  status: string
  vmSize: string
  region: string
  resourceGroup: string
  launchTime?: Date
}

export interface AzureInstanceConfig {
  name: string
  vmSize?: string  // Default: Standard_B1s (1 vCPU, 1GB RAM)
  diskSizeGB?: number // Default: 30GB
  region?: string
  resourceGroup?: string
}

export class AzureClient {
  private computeClient: ComputeManagementClient
  private networkClient: NetworkManagementClient
  private resourceClient: ResourceManagementClient
  private credentials: AzureCredentials
  private region: string
  private credential: ClientSecretCredential

  constructor(credentials: AzureCredentials) {
    this.credentials = credentials
    this.region = credentials.region || DEFAULT_REGION

    this.credential = new ClientSecretCredential(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    )

    this.computeClient = new ComputeManagementClient(
      this.credential,
      credentials.subscriptionId
    )
    this.networkClient = new NetworkManagementClient(
      this.credential,
      credentials.subscriptionId
    )
    this.resourceClient = new ResourceManagementClient(
      this.credential,
      credentials.subscriptionId
    )
  }

  /**
   * Validate Azure credentials by attempting to list resource groups
   */
  async validateCredentials(): Promise<{ valid: boolean; error?: string }> {
    try {
      // Try to list resource groups to validate credentials
      const iterator = this.resourceClient.resourceGroups.list()
      // Just try to get the first item to verify access
      await iterator.next()
      return { valid: true }
    } catch (error: any) {
      if (error.code === 'AuthenticationError' || error.statusCode === 401) {
        return { valid: false, error: 'Invalid Azure credentials' }
      }
      if (error.code === 'AuthorizationFailed' || error.statusCode === 403) {
        return { valid: false, error: 'Insufficient permissions. Service principal needs Contributor access.' }
      }
      return { valid: false, error: error.message || 'Failed to validate credentials' }
    }
  }

  /**
   * Get or create a resource group for Clawdbot VMs
   */
  private async getOrCreateResourceGroup(name: string = 'clawdbot-vms'): Promise<string> {
    try {
      const rg = await this.resourceClient.resourceGroups.get(name)
      return rg.name!
    } catch (error: any) {
      if (error.statusCode === 404) {
        // Resource group doesn't exist, create it
        await this.resourceClient.resourceGroups.createOrUpdate(name, {
          location: this.region,
          tags: {
            CreatedBy: 'Clawdbot',
            Project: 'clawdbot-vm',
          },
        })
        return name
      }
      throw error
    }
  }

  /**
   * Create network security group with SSH access
   */
  private async createNetworkSecurityGroup(
    resourceGroup: string,
    name: string
  ): Promise<string> {
    const nsgName = `${name}-nsg`

    const nsg = await this.networkClient.networkSecurityGroups.beginCreateOrUpdateAndWait(
      resourceGroup,
      nsgName,
      {
        location: this.region,
        securityRules: [
          {
            name: 'SSH',
            protocol: 'Tcp',
            sourcePortRange: '*',
            destinationPortRange: '22',
            sourceAddressPrefix: '*',
            destinationAddressPrefix: '*',
            access: 'Allow',
            priority: 1000,
            direction: 'Inbound',
          },
          {
            name: 'HTTPS-outbound',
            protocol: 'Tcp',
            sourcePortRange: '*',
            destinationPortRange: '443',
            sourceAddressPrefix: '*',
            destinationAddressPrefix: '*',
            access: 'Allow',
            priority: 1001,
            direction: 'Outbound',
          },
        ],
        tags: {
          CreatedBy: 'Clawdbot',
        },
      }
    )

    return nsg.id!
  }

  /**
   * Create virtual network and subnet
   */
  private async createVirtualNetwork(
    resourceGroup: string,
    name: string
  ): Promise<{ vnetId: string; subnetId: string }> {
    const vnetName = `${name}-vnet`
    const subnetName = `${name}-subnet`

    const vnet = await this.networkClient.virtualNetworks.beginCreateOrUpdateAndWait(
      resourceGroup,
      vnetName,
      {
        location: this.region,
        addressSpace: {
          addressPrefixes: ['10.0.0.0/16'],
        },
        subnets: [
          {
            name: subnetName,
            addressPrefix: '10.0.0.0/24',
          },
        ],
        tags: {
          CreatedBy: 'Clawdbot',
        },
      }
    )

    const subnetId = vnet.subnets?.[0]?.id!

    return { vnetId: vnet.id!, subnetId }
  }

  /**
   * Create public IP address
   */
  private async createPublicIp(
    resourceGroup: string,
    name: string
  ): Promise<string> {
    const ipName = `${name}-ip`

    const publicIp = await this.networkClient.publicIPAddresses.beginCreateOrUpdateAndWait(
      resourceGroup,
      ipName,
      {
        location: this.region,
        publicIPAllocationMethod: 'Static',
        sku: {
          name: 'Standard',
        },
        tags: {
          CreatedBy: 'Clawdbot',
        },
      }
    )

    return publicIp.id!
  }

  /**
   * Create network interface
   */
  private async createNetworkInterface(
    resourceGroup: string,
    name: string,
    subnetId: string,
    publicIpId: string,
    nsgId: string
  ): Promise<string> {
    const nicName = `${name}-nic`

    const nic = await this.networkClient.networkInterfaces.beginCreateOrUpdateAndWait(
      resourceGroup,
      nicName,
      {
        location: this.region,
        ipConfigurations: [
          {
            name: 'ipconfig1',
            subnet: {
              id: subnetId,
            },
            publicIPAddress: {
              id: publicIpId,
            },
          },
        ],
        networkSecurityGroup: {
          id: nsgId,
        },
        tags: {
          CreatedBy: 'Clawdbot',
        },
      }
    )

    return nic.id!
  }

  /**
   * Generate SSH key pair for the instance
   */
  private generateSSHKey(): { publicKey: string; privateKey: string } {
    // For Azure, we generate an SSH key using crypto
    const crypto = require('crypto')
    const { generateKeyPairSync } = crypto

    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    })

    // Convert to OpenSSH format for Azure
    const sshPublicKey = require('ssh2').utils.parseKey(publicKey)
    const publicKeyOpenSSH = publicKey.replace('-----BEGIN PUBLIC KEY-----', '')
      .replace('-----END PUBLIC KEY-----', '')
      .replace(/\n/g, '')

    return {
      publicKey: `ssh-rsa ${publicKeyOpenSSH} clawdbot@azure`,
      privateKey,
    }
  }

  /**
   * Create a new Azure VM instance
   */
  async createInstance(config: AzureInstanceConfig): Promise<{ instance: AzureInstance; privateKey: string; adminPassword: string }> {
    const vmSize = config.vmSize || 'Standard_B1s'
    const diskSizeGB = config.diskSizeGB || 30
    const region = config.region || this.region

    // Update region if different
    if (region !== this.region) {
      this.region = region
    }

    // Get or create resource group
    const resourceGroup = config.resourceGroup || await this.getOrCreateResourceGroup()

    // Generate a random admin password for Azure (required even with SSH)
    const adminPassword = `Clawdbot${Math.random().toString(36).slice(-8)}${Math.floor(Math.random() * 100)}!`

    // Create networking resources
    const nsgId = await this.createNetworkSecurityGroup(resourceGroup, config.name)
    const { subnetId } = await this.createVirtualNetwork(resourceGroup, config.name)
    const publicIpId = await this.createPublicIp(resourceGroup, config.name)
    const nicId = await this.createNetworkInterface(resourceGroup, config.name, subnetId, publicIpId, nsgId)

    // Generate SSH key pair
    const { publicKey, privateKey } = this.generateSSHKey()

    // Cloud-init script for initial setup
    const cloudInitScript = `#!/bin/bash
# Update system
apt-get update -y
apt-get upgrade -y

# Install basic tools
apt-get install -y curl git python3 python3-pip openssh-client procps

# Create user for Clawdbot
useradd -m -s /bin/bash clawdbot || true
echo "clawdbot ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/clawdbot

# Mark instance as ready
touch /tmp/clawdbot-ready
`

    const customData = Buffer.from(cloudInitScript).toString('base64')

    // Create VM
    const vm = await this.computeClient.virtualMachines.beginCreateOrUpdateAndWait(
      resourceGroup,
      config.name,
      {
        location: this.region,
        hardwareProfile: {
          vmSize,
        },
        storageProfile: {
          imageReference: UBUNTU_IMAGE,
          osDisk: {
            createOption: 'FromImage',
            managedDisk: {
              storageAccountType: 'Standard_LRS',
            },
            diskSizeGB,
            deleteOption: 'Delete',
          },
        },
        osProfile: {
          computerName: config.name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 15),
          adminUsername: 'clawdbot',
          adminPassword,
          linuxConfiguration: {
            disablePasswordAuthentication: false,
            ssh: {
              publicKeys: [
                {
                  path: '/home/clawdbot/.ssh/authorized_keys',
                  keyData: publicKey,
                },
              ],
            },
          },
          customData,
        },
        networkProfile: {
          networkInterfaces: [
            {
              id: nicId,
              primary: true,
            },
          ],
        },
        tags: {
          Name: config.name,
          CreatedBy: 'Clawdbot',
          Project: 'clawdbot-vm',
        },
      }
    )

    // Get public IP address
    const publicIpResource = await this.networkClient.publicIPAddresses.get(
      resourceGroup,
      `${config.name}-ip`
    )

    const instance: AzureInstance = {
      id: vm.id!,
      name: config.name,
      publicIp: publicIpResource.ipAddress,
      privateIp: vm.networkProfile?.networkInterfaces?.[0]?.id ? undefined : undefined,
      status: vm.provisioningState || 'creating',
      vmSize,
      region: this.region,
      resourceGroup,
    }

    return { instance, privateKey, adminPassword }
  }

  /**
   * Get instance details by name
   */
  async getInstance(resourceGroup: string, name: string): Promise<AzureInstance> {
    const vm = await this.computeClient.virtualMachines.get(resourceGroup, name, {
      expand: 'instanceView',
    })

    // Get public IP
    let publicIp: string | undefined
    try {
      const publicIpResource = await this.networkClient.publicIPAddresses.get(
        resourceGroup,
        `${name}-ip`
      )
      publicIp = publicIpResource.ipAddress
    } catch (error) {
      // Public IP might not exist
    }

    // Get status from instance view
    const statuses = vm.instanceView?.statuses || []
    const powerState = statuses.find(s => s.code?.startsWith('PowerState/'))
    const status = powerState?.code?.replace('PowerState/', '') || vm.provisioningState || 'unknown'

    return {
      id: vm.id!,
      name: vm.name!,
      publicIp,
      status,
      vmSize: vm.hardwareProfile?.vmSize || 'unknown',
      region: vm.location!,
      resourceGroup,
    }
  }

  /**
   * List all Clawdbot VMs
   */
  async listInstances(): Promise<AzureInstance[]> {
    const instances: AzureInstance[] = []

    // List all VMs and filter by tags
    for await (const vm of this.computeClient.virtualMachines.listAll()) {
      if (vm.tags?.CreatedBy === 'Clawdbot') {
        // Extract resource group from VM ID
        const rgMatch = vm.id?.match(/resourceGroups\/([^/]+)/)
        const resourceGroup = rgMatch?.[1] || ''

        // Get public IP
        let publicIp: string | undefined
        try {
          const publicIpResource = await this.networkClient.publicIPAddresses.get(
            resourceGroup,
            `${vm.name}-ip`
          )
          publicIp = publicIpResource.ipAddress
        } catch (error) {
          // Public IP might not exist
        }

        instances.push({
          id: vm.id!,
          name: vm.name!,
          publicIp,
          status: vm.provisioningState || 'unknown',
          vmSize: vm.hardwareProfile?.vmSize || 'unknown',
          region: vm.location!,
          resourceGroup,
        })
      }
    }

    return instances
  }

  /**
   * Start a VM
   */
  async startInstance(resourceGroup: string, name: string): Promise<void> {
    await this.computeClient.virtualMachines.beginStartAndWait(resourceGroup, name)
  }

  /**
   * Stop a VM
   */
  async stopInstance(resourceGroup: string, name: string): Promise<void> {
    await this.computeClient.virtualMachines.beginDeallocateAndWait(resourceGroup, name)
  }

  /**
   * Restart a VM
   */
  async restartInstance(resourceGroup: string, name: string): Promise<void> {
    await this.computeClient.virtualMachines.beginRestartAndWait(resourceGroup, name)
  }

  /**
   * Delete a VM and associated resources
   */
  async deleteInstance(resourceGroup: string, name: string): Promise<void> {
    // Delete VM first
    await this.computeClient.virtualMachines.beginDeleteAndWait(resourceGroup, name)

    // Delete associated resources
    try {
      await this.networkClient.networkInterfaces.beginDeleteAndWait(resourceGroup, `${name}-nic`)
    } catch (error) {}

    try {
      await this.networkClient.publicIPAddresses.beginDeleteAndWait(resourceGroup, `${name}-ip`)
    } catch (error) {}

    try {
      await this.networkClient.virtualNetworks.beginDeleteAndWait(resourceGroup, `${name}-vnet`)
    } catch (error) {}

    try {
      await this.networkClient.networkSecurityGroups.beginDeleteAndWait(resourceGroup, `${name}-nsg`)
    } catch (error) {}
  }

  /**
   * Run command on VM using Azure Run Command
   */
  async executeCommand(
    resourceGroup: string,
    name: string,
    command: string
  ): Promise<{ output: string; exitCode: number }> {
    try {
      const result = await this.computeClient.virtualMachines.beginRunCommandAndWait(
        resourceGroup,
        name,
        {
          commandId: 'RunShellScript',
          script: [command],
        }
      )

      const output = result.value?.[0]?.message || ''
      // Azure Run Command doesn't provide exit code directly, check for errors
      const exitCode = output.includes('error') || output.includes('Error') ? 1 : 0

      return { output, exitCode }
    } catch (error: any) {
      return { output: error.message || 'Command execution failed', exitCode: 1 }
    }
  }

  /**
   * Wait for the instance to be ready
   */
  async waitForReady(resourceGroup: string, name: string, maxAttempts = 30): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await this.executeCommand(
          resourceGroup,
          name,
          'test -f /tmp/clawdbot-ready && echo "ready"'
        )
        if (result.output.includes('ready')) {
          return true
        }
      } catch (error) {
        // Instance might not be ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 10000))
    }
    return false
  }
}

/**
 * Generate a random instance name
 */
export function generateInstanceName(): string {
  const adjectives = ['swift', 'bright', 'calm', 'bold', 'keen', 'wise', 'warm', 'cool']
  const nouns = ['falcon', 'eagle', 'wolf', 'hawk', 'bear', 'lion', 'deer', 'raven']
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
  const noun = nouns[Math.floor(Math.random() * nouns.length)]
  const num = Math.floor(Math.random() * 1000)
  return `clawdbot-${adj}-${noun}-${num}`
}

/**
 * Available Azure regions for Clawdbot VMs
 */
export const AZURE_REGIONS = [
  { id: 'eastus', name: 'East US' },
  { id: 'eastus2', name: 'East US 2' },
  { id: 'westus', name: 'West US' },
  { id: 'westus2', name: 'West US 2' },
  { id: 'westus3', name: 'West US 3' },
  { id: 'centralus', name: 'Central US' },
  { id: 'northeurope', name: 'North Europe' },
  { id: 'westeurope', name: 'West Europe' },
  { id: 'uksouth', name: 'UK South' },
  { id: 'southeastasia', name: 'Southeast Asia' },
  { id: 'australiaeast', name: 'Australia East' },
  { id: 'japaneast', name: 'Japan East' },
]

/**
 * Available VM sizes
 */
export const AZURE_VM_SIZES = [
  // Burstable (B-series) - cost effective
  { id: 'Standard_B1s', name: 'Standard_B1s', vcpu: 1, memory: '1 GB', priceHour: '~$0.01/hr', recommended: false },
  { id: 'Standard_B1ms', name: 'Standard_B1ms', vcpu: 1, memory: '2 GB', priceHour: '~$0.02/hr', recommended: false },
  { id: 'Standard_B2s', name: 'Standard_B2s', vcpu: 2, memory: '4 GB', priceHour: '~$0.04/hr', recommended: true },
  { id: 'Standard_B2ms', name: 'Standard_B2ms', vcpu: 2, memory: '8 GB', priceHour: '~$0.08/hr', recommended: false },
  // General purpose (D-series)
  { id: 'Standard_D2s_v5', name: 'Standard_D2s_v5', vcpu: 2, memory: '8 GB', priceHour: '~$0.10/hr', recommended: false },
  { id: 'Standard_D4s_v5', name: 'Standard_D4s_v5', vcpu: 4, memory: '16 GB', priceHour: '~$0.19/hr', recommended: false },
]
