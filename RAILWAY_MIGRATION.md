# Railway Migration Guide 🚀

## Quick Deploy (5 minutes)

### Step 1: Create Railway Project

1. **Go to Railway**: https://railway.app/new
2. **Click "Deploy from GitHub repo"**
3. **Select your Samantha repository**
4. Railway will auto-detect Next.js and start deploying

### Step 2: Add Environment Variables

Go to your Railway project → **Variables** tab → **Add the following**:

```bash
# ═══════════════════════════════════════════════════════════════
# REQUIRED - Database (keep using your existing Neon database)
# ═══════════════════════════════════════════════════════════════
POSTGRES_PRISMA_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require&pgbouncer=true
POSTGRES_URL_NON_POOLING=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require

# ═══════════════════════════════════════════════════════════════
# REQUIRED - Authentication
# ═══════════════════════════════════════════════════════════════
NEXTAUTH_SECRET=your-32-char-secret-here
# Update this AFTER you get your Railway URL:
NEXTAUTH_URL=https://your-app.up.railway.app

# ═══════════════════════════════════════════════════════════════
# REQUIRED - Google OAuth (for user login)
# ═══════════════════════════════════════════════════════════════
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret

# ═══════════════════════════════════════════════════════════════
# OPTIONAL - Gmail/Calendar Integration
# ═══════════════════════════════════════════════════════════════
GOOGLE_REDIRECT_URI=https://your-app.up.railway.app/api/integrations/gmail/callback

# ═══════════════════════════════════════════════════════════════
# OPTIONAL - Telegram Integration (for Clawdbot)
# ═══════════════════════════════════════════════════════════════
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_USER_ID=your-telegram-user-id

# ═══════════════════════════════════════════════════════════════
# OPTIONAL - Cron Job Protection
# ═══════════════════════════════════════════════════════════════
CRON_SECRET=your-cron-secret-for-securing-cron-endpoints
```

### Step 3: Get Your Railway URL

After first deployment:
1. Go to **Settings** → **Networking** → **Generate Domain**
2. Copy your URL (e.g., `https://samantha-production.up.railway.app`)
3. Update `NEXTAUTH_URL` in Variables with this URL
4. Railway will automatically redeploy

### Step 4: Update Google OAuth Redirect URIs

Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. Select your OAuth 2.0 Client ID
2. Add these Authorized redirect URIs:
   - `https://your-app.up.railway.app/api/auth/callback/google`
   - `https://your-app.up.railway.app/api/integrations/gmail/callback`
   - `https://your-app.up.railway.app/api/integrations/calendar/callback`

### Step 5: Test VM Provisioning

1. Go to your Railway app URL
2. Sign in with Google
3. Start a new VM setup
4. Watch it complete successfully in ~20 minutes! 🎉

---

## Why Railway Works (and Vercel Doesn't)

### Vercel Limits
- ❌ 60 second function timeout (Pro plan)
- ❌ Your VM setup takes 15-25 minutes
- ❌ Setup gets killed, VMs stuck in "provisioning"

### Railway Benefits
- ✅ **No timeout limits** - processes run as long as needed
- ✅ Full VM provisioning completes successfully
- ✅ SSH connections stay alive
- ✅ SSE streams work properly
- ✅ Same deployment simplicity as Vercel

---

## Optional: Custom Domain Setup

1. Go to **Settings** → **Networking** → **Custom Domain**
2. Add your domain (e.g., `samantha.yourdomain.com`)
3. Add the CNAME record to your DNS:
   ```
   CNAME  samantha  your-app.up.railway.app
   ```
4. Update `NEXTAUTH_URL` to use your custom domain
5. Update Google OAuth redirect URIs with your custom domain

---

## Cost Comparison

| Plan | Vercel | Railway |
|------|--------|---------|
| **Hobby** | $0 (10s timeout) | $5/month |
| **Pro** | $20/month (60s timeout - still broken) | $20/month (no limits) |
| **Your use case** | ❌ Doesn't work | ✅ Works perfectly |

---

## Rollback Plan

If anything goes wrong:
1. Your Vercel deployment is still there
2. Your Neon database is unchanged
3. Just point DNS back to Vercel

---

## Support

Railway Docs: https://docs.railway.app
Railway Discord: https://discord.gg/railway
