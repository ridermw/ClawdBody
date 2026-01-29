/**
 * Azure VM Setup Scripts
 * Commands to configure Azure VMs with all required tools
 * Uses SSH for command execution
 */

import { AzureClient, AzureInstance } from './azure'
import { Client as SSHClient } from 'ssh2'

export interface SetupProgress {
  step: string
  message: string
  success: boolean
  output?: string
}

export class AzureVMSetup {
  private azureClient: AzureClient
  private resourceGroup: string
  private vmName: string
  private publicIp?: string
  private privateKey: string
  private onProgress?: (progress: SetupProgress) => void
  private sshClient?: SSHClient
  private sshConnected: boolean = false

  constructor(
    azureClient: AzureClient,
    resourceGroup: string,
    vmName: string,
    privateKey: string,
    publicIp?: string,
    onProgress?: (progress: SetupProgress) => void
  ) {
    this.azureClient = azureClient
    this.resourceGroup = resourceGroup
    this.vmName = vmName
    this.privateKey = privateKey
    this.publicIp = publicIp
    this.onProgress = onProgress
  }

  /**
   * Connect to the instance via SSH
   */
  private async connectSSH(): Promise<void> {
    if (this.sshConnected && this.sshClient) {
      return
    }

    if (!this.publicIp) {
      // Get the public IP from Azure
      const instance = await this.azureClient.getInstance(this.resourceGroup, this.vmName)
      this.publicIp = instance.publicIp

      if (!this.publicIp) {
        throw new Error('Instance does not have a public IP address')
      }
    }

    return new Promise((resolve, reject) => {
      this.sshClient = new SSHClient()

      this.sshClient.on('ready', () => {
        this.sshConnected = true
        resolve()
      })

      this.sshClient.on('error', (err) => {
        this.sshConnected = false
        reject(new Error(`SSH connection failed: ${err.message}`))
      })

      this.sshClient.connect({
        host: this.publicIp,
        port: 22,
        username: 'clawdbot', // Azure VM admin user we created
        privateKey: this.privateKey,
        readyTimeout: 60000,
      })
    })
  }

  /**
   * Disconnect SSH
   */
  private disconnectSSH(): void {
    if (this.sshClient) {
      this.sshClient.end()
      this.sshConnected = false
    }
  }

  /**
   * Run a command via SSH
   */
  private async runCommand(command: string, step: string, retries: number = 2): Promise<{ output: string; success: boolean }> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Ensure SSH is connected
        await this.connectSSH()

        const result = await this.executeSSH(command)
        const success = result.exitCode === 0

        this.onProgress?.({
          step,
          message: success ? `Completed: ${step}` : `Failed: ${step}`,
          success,
          output: result.output,
        })

        return { output: result.output, success }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error')
        const message = lastError.message

        // If it's a connection error, wait and retry
        if (attempt < retries && (message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT') || message.includes('SSH'))) {
          const waitTime = (attempt + 1) * 5000 // Exponential backoff: 5s, 10s
          this.disconnectSSH()
          await new Promise(resolve => setTimeout(resolve, waitTime))
          continue
        }

        this.onProgress?.({
          step,
          message: `Error: ${message}`,
          success: false,
        })
        return { output: message, success: false }
      }
    }

    const message = lastError?.message || 'Unknown error'
    return { output: message, success: false }
  }

  /**
   * Execute command over SSH
   */
  private executeSSH(command: string): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      if (!this.sshClient || !this.sshConnected) {
        reject(new Error('SSH not connected'))
        return
      }

      this.sshClient.exec(command, (err, stream) => {
        if (err) {
          reject(err)
          return
        }

        let output = ''
        let exitCode = 0

        stream.on('close', (code: number) => {
          exitCode = code || 0
          resolve({ output, exitCode })
        })

        stream.on('data', (data: Buffer) => {
          output += data.toString()
        })

        stream.stderr.on('data', (data: Buffer) => {
          output += data.toString()
        })
      })
    })
  }

  /**
   * Wait for VM to be ready by testing a simple command
   */
  private async waitForVMReady(maxRetries: number = 20, delayMs: number = 15000): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.connectSSH()
        const result = await this.executeSSH('echo "ready"')
        if (result.exitCode === 0) {
          return true
        }
      } catch (error) {
        // VM not ready yet, continue waiting
        this.disconnectSSH()
      }

      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
    return false
  }

  /**
   * Generate SSH key pair for GitHub access
   */
  async generateSSHKey(): Promise<{ publicKey: string; success: boolean }> {
    // Ensure .ssh directory exists
    const mkdirResult = await this.runCommand(
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
      'Create .ssh directory'
    )

    if (!mkdirResult.success) {
      return { publicKey: '', success: false }
    }

    // Remove existing key if it exists (we want a fresh key)
    await this.runCommand(
      'rm -f ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub',
      'Remove existing SSH key if present'
    )

    // Generate SSH key
    const keyGen = await this.runCommand(
      'ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -C "clawdbot-azure-vm"',
      'Generate SSH key'
    )

    if (!keyGen.success) {
      return { publicKey: '', success: false }
    }

    // Get public key
    const pubKey = await this.runCommand('cat ~/.ssh/id_ed25519.pub', 'Read public key')

    if (!pubKey.success || !pubKey.output.trim()) {
      return { publicKey: '', success: false }
    }

    return {
      publicKey: pubKey.output.trim(),
      success: true
    }
  }

  /**
   * Configure Git with user info
   */
  async configureGit(username: string, email: string): Promise<boolean> {
    const commands = [
      `git config --global user.name "${username}"`,
      `git config --global user.email "${email}"`,
      'git config --global init.defaultBranch main',
      'mkdir -p ~/.ssh && ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null',
    ]

    for (const cmd of commands) {
      const result = await this.runCommand(cmd, 'Configure Git')
      if (!result.success) return false
    }

    return true
  }

  /**
   * Clone the vault repository
   */
  async cloneVaultRepo(sshUrl: string): Promise<boolean> {
    const result = await this.runCommand(
      `rm -rf ~/vault && git clone ${sshUrl} ~/vault`,
      'Clone vault repository'
    )
    return result.success
  }

  /**
   * Link the vault to Clawdbot's knowledge directory
   */
  async linkVaultToKnowledge(): Promise<boolean> {
    await this.runCommand(
      'mkdir -p /home/clawdbot/clawd/knowledge',
      'Create Clawdbot knowledge directory'
    )

    const linkResult = await this.runCommand(
      'ln -sf ~/vault /home/clawdbot/clawd/knowledge/vault',
      'Link vault to Clawdbot knowledge'
    )

    if (linkResult.success) {
      this.onProgress?.({
        step: 'Link vault',
        message: 'Vault linked to /home/clawdbot/clawd/knowledge/vault',
        success: true,
      })
    }

    return linkResult.success
  }

  /**
   * Install Python, Git, SSH and other essential tools
   */
  async installPython(): Promise<boolean> {
    const vmReady = await this.waitForVMReady(20, 15000)
    if (!vmReady) {
      return false
    }

    // Wait for cloud-init to complete (apt-get is locked during cloud-init)
    const cloudInitCommands = [
      // Wait for cloud-init to finish
      'cloud-init status --wait || true',
      // Kill any stuck apt processes and release locks
      'sudo killall apt apt-get dpkg 2>/dev/null || true',
      'sudo rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock 2>/dev/null || true',
      'sudo dpkg --configure -a 2>/dev/null || true',
    ]

    for (const cmd of cloudInitCommands) {
      await this.runCommand(cmd, 'Wait for cloud-init')
    }

    const commands = [
      'sudo apt-get update -qq',
      'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-pip python3-venv git openssh-client procps curl',
    ]

    for (const cmd of commands) {
      let retries = 5
      let success = false

      while (retries > 0 && !success) {
        const result = await this.runCommand(cmd, 'Install Python')
        if (result.success) {
          success = true
        } else {
          retries--
          if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 10000))
          }
        }
      }

      if (!success) {
        return false
      }
    }

    return true
  }

  /**
   * Install Anthropic Python SDK
   */
  async installAnthropicSDK(): Promise<boolean> {
    const result = await this.runCommand(
      'pip3 install anthropic langchain-anthropic requests Pillow --break-system-packages',
      'Install Anthropic SDK and dependencies'
    )

    if (!result.success) {
      // SDK installation had issues
    }

    const verify = await this.runCommand(
      'python3 -c "import anthropic; import PIL; print(\'Anthropic SDK and Pillow installed\')"',
      'Verify SDK installation'
    )

    if (!verify.success) {
      this.onProgress?.({
        step: 'Install SDKs',
        message: 'SDK installation had issues, continuing...',
        success: true,
      })
    }

    return true
  }

  /**
   * Install NVM, Node.js 22, and Clawdbot
   */
  async installClawdbot(): Promise<{ success: boolean; version?: string }> {
    this.onProgress?.({
      step: 'Install Clawdbot',
      message: 'Updating system packages...',
      success: true,
    })

    await this.runCommand('sudo apt-get update -qq', 'Update system packages')

    this.onProgress?.({
      step: 'Install Clawdbot',
      message: 'Installing NVM...',
      success: true,
    })

    const nvmInstall = await this.runCommand(
      'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash',
      'Install NVM'
    )

    if (!nvmInstall.success) {
      return { success: false }
    }

    this.onProgress?.({
      step: 'Install Clawdbot',
      message: 'Installing Node.js 22...',
      success: true,
    })

    const nodeInstall = await this.runCommand(
      'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm install 22 && nvm alias default 22',
      'Install Node.js 22'
    )

    if (!nodeInstall.success) {
      return { success: false }
    }

    this.onProgress?.({
      step: 'Install Clawdbot',
      message: 'Installing Clawdbot (this may take a few minutes)...',
      success: true,
    })

    const clawdbotInstall = await this.runCommand(
      'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && npm install -g clawdbot@latest',
      'Install Clawdbot'
    )

    if (!clawdbotInstall.success) {
      return { success: false }
    }

    // Get installed version
    const versionResult = await this.runCommand(
      'cat ~/.nvm/versions/node/*/lib/node_modules/clawdbot/package.json 2>/dev/null | grep -o \'"version": "[^"]*"\' | head -1 | cut -d\'"\' -f4',
      'Get Clawdbot version'
    )

    const version = versionResult.output.trim() || '2026.1.22'

    this.onProgress?.({
      step: 'Install Clawdbot',
      message: `Clawdbot ${version} installed successfully`,
      success: true,
    })

    return { success: true, version }
  }

  /**
   * Configure Clawdbot with Telegram and heartbeat
   */
  async setupClawdbotTelegram(options: {
    claudeApiKey: string
    telegramBotToken: string
    telegramUserId?: string
    clawdbotVersion?: string
    heartbeatIntervalMinutes?: number
    userId?: string
    apiBaseUrl?: string
  }): Promise<boolean> {
    const {
      claudeApiKey,
      telegramBotToken,
      telegramUserId,
      clawdbotVersion = '2026.1.22',
      heartbeatIntervalMinutes = 30,
      userId,
      apiBaseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000'
    } = options

    // Create directories
    await this.runCommand('mkdir -p ~/.clawdbot /home/clawdbot/clawd/knowledge', 'Create Clawdbot directories')

    // Generate gateway token
    const tokenResult = await this.runCommand('openssl rand -hex 24', 'Generate gateway token')
    const gatewayToken = tokenResult.output.trim() || 'fallback-token-' + Date.now()

    const allowFromJson = telegramUserId ? `"allowFrom": ["${telegramUserId}"],` : ''

    // Create CLAUDE.md for workspace
    const claudeMdContent = `# Clawdbot - Autonomous AI Assistant

You are Clawdbot, an autonomous AI assistant running on Azure VM with access to a knowledge repository.

Your workspace is at /home/clawdbot/clawd.

## Knowledge Directory Structure
- /home/clawdbot/clawd/knowledge/vault - The main GitHub vault repository (auto-synced every minute)
- /home/clawdbot/clawd/knowledge/* - Additional knowledge repositories

## Behavior

**When receiving user messages:**
- Prioritize and execute user-requested tasks immediately
- Be helpful, proactive, and thorough

**During heartbeat (periodic check):**
1. Check /home/clawdbot/clawd/knowledge/vault for updates
2. Look for tasks.md, TODO.md, or any task lists in the vault
3. If you find actionable tasks, create a plan and begin execution
4. Report significant progress or findings to the user via chat
`

    const claudeMdB64 = Buffer.from(claudeMdContent).toString('base64')
    await this.runCommand(
      `echo '${claudeMdB64}' | base64 -d > /home/clawdbot/clawd/CLAUDE.md`,
      'Create CLAUDE.md system prompt'
    )

    // Create config JSON
    const configJson = `{
  "meta": {
    "lastTouchedVersion": "${clawdbotVersion}"
  },
  "auth": {
    "profiles": {
      "anthropic:default": {
        "provider": "anthropic",
        "mode": "api_key"
      }
    }
  },
  "agents": {
    "defaults": {
      "workspace": "/home/clawdbot/clawd",
      "compaction": {
        "mode": "safeguard"
      },
      "maxConcurrent": 4,
      "heartbeat": {
        "every": "${heartbeatIntervalMinutes}m",
        "target": "last",
        "activeHours": { "start": "00:00", "end": "24:00" }
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "${telegramBotToken}",
      "dmPolicy": "allowlist",
      ${allowFromJson}
      "groupPolicy": "allowlist"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "${gatewayToken}"
    }
  }
}`

    const configB64 = Buffer.from(configJson).toString('base64')
    const writeConfig = await this.runCommand(
      `echo '${configB64}' | base64 -d > ~/.clawdbot/clawdbot.json`,
      'Write Clawdbot config'
    )

    if (!writeConfig.success) {
      return false
    }

    // Add environment variables to bashrc
    const bashrcAdditions = `
# Clawdbot configuration
export NVM_DIR="\\$HOME/.nvm"
[ -s "\\$NVM_DIR/nvm.sh" ] && . "\\$NVM_DIR/nvm.sh"
export ANTHROPIC_API_KEY='${claudeApiKey}'
export TELEGRAM_BOT_TOKEN='${telegramBotToken}'
`

    await this.runCommand(
      `cat >> ~/.bashrc << 'BASHEOF'
${bashrcAdditions}
BASHEOF`,
      'Configure environment'
    )

    this.onProgress?.({
      step: 'Setup Clawdbot',
      message: 'Clawdbot configured with Telegram',
      success: true,
    })

    return true
  }

  /**
   * Start the Clawdbot gateway as a background process
   */
  async startClawdbotGateway(claudeApiKey: string, telegramBotToken: string): Promise<boolean> {
    // Create startup script with better error handling
    const startupScript = `#!/bin/bash
# Don't use set -e, we want to log errors

# Source bashrc to get environment
source ~/.bashrc 2>/dev/null || true

# Setup NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Set environment variables
export ANTHROPIC_API_KEY="${claudeApiKey}"
export TELEGRAM_BOT_TOKEN="${telegramBotToken}"

# Log startup
LOG_FILE="/tmp/clawdbot.log"
echo "[$(date +'%Y-%m-%d %H:%M:%S')] Starting Clawdbot gateway..." >> "$LOG_FILE"
echo "[$(date +'%Y-%m-%d %H:%M:%S')] NVM_DIR: $NVM_DIR" >> "$LOG_FILE"
echo "[$(date +'%Y-%m-%d %H:%M:%S')] Node version: $(node -v 2>&1 || echo 'node not found')" >> "$LOG_FILE"
echo "[$(date +'%Y-%m-%d %H:%M:%S')] PATH: $PATH" >> "$LOG_FILE"

# Check if clawdbot is available
if ! command -v clawdbot &> /dev/null; then
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: clawdbot command not found" >> "$LOG_FILE"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] Checking NVM..." >> "$LOG_FILE"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] Node path: $(which node || echo 'node not in PATH')" >> "$LOG_FILE"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] Clawdbot path: $(find ~/.nvm -name clawdbot 2>/dev/null | head -1 || echo 'clawdbot not found')" >> "$LOG_FILE"
    exit 1
fi

echo "[$(date +'%Y-%m-%d %H:%M:%S')] Clawdbot found: $(which clawdbot)" >> "$LOG_FILE"
echo "[$(date +'%Y-%m-%d %H:%M:%S')] Running: clawdbot gateway run" >> "$LOG_FILE"
if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ANTHROPIC_API_KEY: SET" >> "$LOG_FILE"
else
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ANTHROPIC_API_KEY: NOT SET" >> "$LOG_FILE"
fi
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] TELEGRAM_BOT_TOKEN: SET" >> "$LOG_FILE"
else
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] TELEGRAM_BOT_TOKEN: NOT SET" >> "$LOG_FILE"
fi

# Check config file exists
if [ -f ~/.clawdbot/clawdbot.json ]; then
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] Config file exists" >> "$LOG_FILE"
else
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: Config file not found at ~/.clawdbot/clawdbot.json" >> "$LOG_FILE"
fi

# Run gateway and capture all output (both stdout and stderr)
clawdbot gateway run >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "[$(date +'%Y-%m-%d %H:%M:%S')] Gateway exited with code: $EXIT_CODE" >> "$LOG_FILE"
exit $EXIT_CODE
`

    const scriptB64 = Buffer.from(startupScript).toString('base64')

    await this.runCommand(
      `echo '${scriptB64}' | base64 -d > /tmp/start-clawdbot.sh && chmod +x /tmp/start-clawdbot.sh`,
      'Create Clawdbot startup script'
    )

    // Kill any existing gateway
    await this.runCommand("pkill -f 'clawdbot gateway' 2>/dev/null || true", 'Kill existing gateway')
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Start gateway in background
    await this.runCommand(
      'nohup /tmp/start-clawdbot.sh >> /tmp/clawdbot.log 2>&1 & echo $!',
      'Start Clawdbot gateway'
    )

    await new Promise(resolve => setTimeout(resolve, 8000))

    // Check if running (with retries and port verification)
    let isRunning = false
    for (let attempt = 0; attempt < 5; attempt++) {
      // Check if process exists
      const processCheck = await this.runCommand(
        "pgrep -f 'clawdbot gateway' > /dev/null && echo 'PROCESS_EXISTS' || echo 'NO_PROCESS'",
        'Check gateway process'
      )

      const hasProcess = processCheck.output.includes('PROCESS_EXISTS')

      if (hasProcess) {
        // Also verify port is listening (more reliable check)
        const portCheck = await this.runCommand(
          "netstat -tlnp 2>/dev/null | grep 18789 > /dev/null || ss -tlnp 2>/dev/null | grep 18789 > /dev/null && echo 'PORT_LISTENING' || echo 'PORT_NOT_LISTENING'",
          'Check gateway port'
        )

        if (portCheck.output.includes('PORT_LISTENING')) {
          isRunning = true
          break
        } else {
          // Process exists but port not listening yet - wait longer
        }
      }

      // Wait before next check
      if (attempt < 4) {
        await new Promise(resolve => setTimeout(resolve, 5000))
      }
    }

    // If not running, check the log for errors
    if (!isRunning) {
      await this.runCommand(
        'tail -20 /tmp/clawdbot.log 2>/dev/null || echo "No log file"',
        'Check gateway logs'
      )
    }

    this.onProgress?.({
      step: 'Start Gateway',
      message: isRunning
        ? 'Clawdbot gateway is running'
        : 'Gateway failed to start. Check /tmp/clawdbot.log for errors.',
      success: isRunning,
    })

    return isRunning
  }

  /**
   * Set up Git sync service
   */
  async setupGitSync(): Promise<boolean> {
    const syncScript = `#!/bin/bash
cd ~/vault
git fetch origin main
git reset --hard origin/main
`

    const createScript = await this.runCommand(
      `cat > ~/sync-vault.sh << 'EOF'
${syncScript}
EOF
chmod +x ~/sync-vault.sh`,
      'Create sync script'
    )

    if (!createScript.success) return false

    // Try cron first
    const cronResult = await this.runCommand(
      '(crontab -l 2>/dev/null | grep -v "sync-vault.sh"; echo "* * * * * /home/clawdbot/sync-vault.sh >> /home/clawdbot/vault-sync.log 2>&1") | crontab -',
      'Setup cron job for vault sync'
    )

    if (cronResult.success) {
      this.onProgress?.({
        step: 'Git Sync',
        message: 'Vault sync configured via cron (every 1 minute)',
        success: true,
      })
      return true
    }

    // Fallback to background daemon
    const daemonScript = `#!/bin/bash
LOG_FILE=~/vault-sync.log
while true; do
    ~/sync-vault.sh >> $LOG_FILE 2>&1
    sleep 60
done
`

    await this.runCommand(
      `cat > ~/vault-sync-daemon.sh << 'EOF'
${daemonScript}
EOF
chmod +x ~/vault-sync-daemon.sh`,
      'Create sync daemon script'
    )

    const startDaemon = await this.runCommand(
      'nohup ~/vault-sync-daemon.sh > /dev/null 2>&1 &',
      'Start vault sync daemon'
    )

    return startDaemon.success
  }

  /**
   * Store Claude API key
   */
  async storeClaudeKey(apiKey: string): Promise<boolean> {
    const result = await this.runCommand(
      `echo 'export ANTHROPIC_API_KEY="${apiKey}"' >> ~/.bashrc`,
      'Store Claude API key'
    )
    return result.success
  }

  /**
   * Cleanup: Close SSH connection
   */
  cleanup(): void {
    this.disconnectSSH()
  }
}
