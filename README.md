# ClawdBody - 1-Click ClawdBot Deployment

https://clawdbody.com/

ClawdBody is a 1-click deployment platform for ClawdBot that runs 24/7 on cloud VMs, automating your life and business. ClawdBot is an autonomous AI agent with **persistent memory**, **intelligent reasoning**, and the ability to **act** in the real world.

## Features

- 🚀 **1-Click Deployment** - Deploy ClawdBot to cloud VMs in minutes
- ☁️ **Multi-Provider Support** - Works with Orgo, AWS, E2B, and more
- 📧 **Email Integration** - ClawdBot can send and reply to emails via Gmail
- 📅 **Calendar Management** - Create, update, and delete calendar events
- 🖥️ **Web Terminal** - Built-in terminal for real-time interaction
- 🤖 **Telegram Bot** - Optional Telegram integration for mobile access
- 💾 **Persistent Memory** - ClawdBot remembers context across sessions
- 🔒 **Secure** - OAuth-based integrations with encrypted token storage

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       Cloud VM (Orgo/AWS/E2B)                    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                     ClawdBot                              │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────────────┐  │   │
│  │  │ Claude API │  │ Browser    │  │ Communication API  │  │   │
│  │  │ Reasoning  │  │ Automation │  │ Gmail + Calendar   │  │   │
│  │  └────────────┘  └────────────┘  └────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              ClawdBody Web Interface                      │   │
│  │  • Web Terminal  • VM Setup  • Integration Management    │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Role | Technology |
|-----------|------|------------|
| **ClawdBody** | Deployment & management platform | Next.js, Prisma, PostgreSQL |
| **ClawdBot** | Autonomous AI agent | Claude API, Python |
| **VM** | Execution environment | Orgo/AWS/E2B cloud VMs |
| **Integrations** | Communication & automation | Gmail API, Google Calendar API |
| **Web Terminal** | Real-time interaction | WebSockets, xterm.js |

## Setup

### Prerequisites

- Node.js 18+
- GitHub account
- [Claude API key](https://console.anthropic.com/settings/keys)
- [Orgo API key](https://orgo.ai/workspaces)

### 1. Clone and Install

```bash
git clone https://github.com/Prakshal-Jain/ClawdBody.git
cd ClawdBody
npm install
```

### 2. Configure Environment

Create `.env` file:

```bash
# Google OAuth App credentials (for authentication)
# Create at: https://console.cloud.google.com/
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/callback/google

# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your_secret_here  # Generate with: openssl rand -base64 32

# Orgo API Key (optional, if using Orgo as VM provider)
ORGO_API_KEY=sk_live_your_orgo_api_key

# Database (PostgreSQL)
# For local dev, use Docker: docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/helloworld?schema=public"
# If using connection pooling (Vercel, Supabase), also set:
# DIRECT_URL="postgresql://..."

# Cron Job Secret (optional, for securing cron endpoints)
CRON_SECRET=your_cron_secret_here  # Generate with: openssl rand -base64 32
```

### 3. Set up Database

```bash
npx prisma generate
npx prisma db push
```

### 4. Create Google OAuth App

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client ID"
4. Configure OAuth consent screen first if prompted
5. Configure credentials:
   - **Application type**: Web application
   - **Authorized redirect URIs**: `http://localhost:3000/api/auth/callback/google`
6. Copy Client ID and Client Secret to `.env`

### 5. Run the App

```bash
npm run dev
```

Visit `http://localhost:3000` and sign in with Google.

## What Happens During Setup

1. **Google OAuth** - Sign in with your Google account
2. **API Keys** - Enter your Claude API key and choose a VM provider (Orgo/AWS/E2B)
3. **VM Provisioning** - Creates a VM with your selected provider
4. **VM Configuration**:
   - Installs Python and essential tools
   - Installs Anthropic SDK for Claude
   - Installs ClawdBot for autonomous task execution
   - Configures communication helper scripts for Gmail/Calendar integration
   - Configures Telegram bot (optional)

## Integrations

ClawdBody supports integrations with Gmail, Google Calendar, and GitHub. ClawdBot can use these integrations automatically without additional OAuth setup - it reuses the tokens stored in your database.

### Available Integrations

- **Gmail** - Send/reply to emails, read messages
- **Google Calendar** - Create, update, delete calendar events
- **GitHub** - Repository management (coming soon)
- **Slack** - Team communication (coming soon)

### Communication API

ClawdBot can use the communication features via a helper script automatically installed on the VM:

**Sending Emails:**
```bash
/home/user/clawd/send_communication.sh send_email \
  --to "recipient@example.com" \
  --subject "Subject line" \
  --body "Email body text"
```

**Creating Calendar Events:**
```bash
/home/user/clawd/send_communication.sh create_event \
  --summary "Meeting Title" \
  --start "2024-01-15T10:00:00Z" \
  --end "2024-01-15T11:00:00Z" \
  --description "Meeting description"
```

See `CLAWDBOT_COMMUNICATION.md` for complete documentation.

## After Setup

### Using ClawdBot

Once setup is complete, ClawdBot runs 24/7 on your VM, ready to execute tasks. You can:

1. **Connect via Terminal** - Use the web-based terminal to interact with ClawdBot
2. **Connect Gmail/Calendar** - Enable communication capabilities from the Learning Sources page
3. **Use Telegram** - Interact with ClawdBot via Telegram (if configured)

### Monitoring

- **VM Console**: View at your VM provider's dashboard (Orgo/AWS/E2B)
- **Web Terminal**: Monitor ClawdBot activity through the built-in terminal
- **Learning Sources**: Check integration status and manage connections

## Vercel Deployment

### 1. Connect to Vercel

Since the repository is public, you can deploy directly:

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your GitHub repository: `Prakshal-Jain/ClawdBody`
3. Vercel will auto-detect Next.js settings

### 2. Configure Environment Variables

In Vercel Dashboard → Project Settings → Environment Variables, add:

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string (pooled, use Vercel Postgres, Supabase, or PlanetScale) | ✅ |
| `DIRECT_URL` | Direct PostgreSQL connection (non-pooled, for migrations) | ✅ |
| `NEXTAUTH_URL` | Your Vercel URL (e.g., `https://clawdbody.vercel.app`) | ✅ |
| `NEXTAUTH_SECRET` | Generate with: `openssl rand -base64 32` | ✅ |
| `GITHUB_CLIENT_ID` | From GitHub OAuth App | ✅ |
| `GITHUB_CLIENT_SECRET` | From GitHub OAuth App | ✅ |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console | For Gmail/Calendar |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console | For Gmail/Calendar |
| `ORGO_API_KEY` | From Orgo dashboard | For VM integration |
| `CRON_SECRET` | Generate with: `openssl rand -hex 16` | For cron jobs |
| `TELEGRAM_BOT_TOKEN` | From BotFather | Optional, for Telegram bot |
| `TELEGRAM_USER_ID` | Your Telegram user ID | Optional, for Telegram bot |

### 3. Set Up Production Database

**Option A: Vercel Postgres (Recommended)**
1. In Vercel Dashboard → Storage → Create Database → Postgres
2. It will auto-populate `DATABASE_URL`

**Option B: Supabase**
1. Create project at [supabase.com](https://supabase.com)
2. Copy connection string to `DATABASE_URL`

### 4. Update OAuth Redirect URIs

Update your OAuth apps with production URLs:

**GitHub OAuth App:**
- Authorization callback URL: `https://your-app.vercel.app/api/auth/callback/github`

**Google OAuth App:**
- Authorized redirect URIs:
  - `https://your-app.vercel.app/api/auth/callback/google`
  - `https://your-app.vercel.app/api/integrations/gmail/callback`
  - `https://your-app.vercel.app/api/integrations/calendar/callback`

### 5. Deploy

Push to GitHub and Vercel will automatically build and deploy:

```bash
git add .
git commit -m "Configure for Vercel deployment"
git push origin main
```

## Development

```bash
# Run in development
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## API Reference

### Communication API
See `CLAWDBOT_COMMUNICATION.md` for detailed documentation on:
- Sending and replying to emails
- Creating, updating, and deleting calendar events
- API endpoint specifications and authentication

### VM Provider APIs
- **Orgo**: [Documentation](https://docs.orgo.ai)
- **AWS**: EC2 and SSM for VM management
- **E2B**: [Documentation](https://e2b.dev/docs)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Setup

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/ClawdBody.git`
3. Install dependencies: `npm install`
4. Set up environment variables (see `.env` section above)
5. Run development server: `npm run dev`

### Repository

- **GitHub**: [Prakshal-Jain/ClawdBody](https://github.com/Prakshal-Jain/ClawdBody)
- **Issues**: Report bugs or request features via GitHub Issues
- **Pull Requests**: Submit PRs for bug fixes or new features

## Support

For questions or issues:
- Open an issue on [GitHub](https://github.com/Prakshal-Jain/ClawdBody/issues)
- Check existing documentation in the repository

## License

MIT


