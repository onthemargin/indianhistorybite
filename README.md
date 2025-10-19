# Indian History Bite

A web application that delivers daily bite-sized stories from Indian history.

**Built by [On The Margin](https://onthemargin.io) with [Claude Code](https://claude.ai/code)**

## Features

- 📱 Mobile-first responsive design
- 📖 Historical stories with shareable quotes
- ⚡ Fast loading and lightweight
- 🎨 Modern, clean interface
- 🔄 Daily content updates

## Self-Hosting Guide

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn package manager
- Claude API key from Anthropic
- A domain or server to host the app

### Step 1: Clone and Setup

```bash
git clone https://github.com/yourusername/indianhistorybite.git
cd indianhistorybite/app
npm install
```

### Step 2: Environment Configuration

Copy the example environment file and configure your settings:

```bash
cp .env.example .env
```

Edit `.env` file with your configuration:

```env
# Required: Claude API Key from Anthropic
CLAUDE_API_KEY=your_claude_api_key_here

# Optional: App API key for securing refresh endpoint
APP_API_KEY=your_secure_random_string

# Optional: Port (defaults to 3001)
PORT=3001

# Optional: Base path for reverse proxy setups
BASE_PATH=/indianhistorybite

# Optional: Runtime directory
RUNTIME_DIR=../runtime
```

### Step 3: Generate VAPID Keys (Optional)

```bash
node generate-vapid-keys.js
```

This creates `vapid-keys.env` with your VAPID keys.

### Step 4: Development

Start the development server:

```bash
npm start
```

Visit `http://localhost:3001` to see your app.

### Step 5: Production Deployment

#### Option A: Simple Server Deployment

1. **Generate production keys:**
   ```bash
   node generate-production-keys.js
   ```

2. **Install as system service (Linux):**
   ```bash
   sudo cp indianhistorybite.service.template /etc/systemd/system/indianhistorybite.service
   sudo systemctl daemon-reload
   sudo systemctl enable indianhistorybite
   sudo systemctl start indianhistorybite
   ```

3. **Configure reverse proxy (nginx example):**
   ```nginx
   server {
       listen 80;
       server_name yourdomain.com;
       
       location /indianhistorybite {
           proxy_pass http://localhost:3001;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

#### Option B: Docker Deployment

Create a `Dockerfile`:

```dockerfile
FROM node:16-alpine
WORKDIR /app
COPY app/package*.json ./
RUN npm ci --only=production
COPY app/ .
COPY runtime/ ../runtime/
EXPOSE 3001
CMD ["node", "src/server.js"]
```

Build and run:

```bash
docker build -t indianhistorybite .
docker run -d -p 3001:3001 --env-file .env indianhistorybite
```

#### Option C: Cloud Platform Deployment

**Heroku:**
1. Install Heroku CLI
2. Create app: `heroku create your-app-name`
3. Set environment variables: `heroku config:set CLAUDE_API_KEY=your_key`
4. Deploy: `git push heroku main`

**Railway/Render/Vercel:**
1. Connect your GitHub repository
2. Set environment variables in the platform dashboard
3. Deploy automatically from your main branch

### Step 6: Customize Content

Edit `runtime/data/prompt.txt` to customize the historical content generation:

```text
Generate a historically accurate, engaging story about Indian history...
[Customize this prompt to your preferences]
```

### Monitoring and Maintenance

- **Logs:** Check `runtime/logs/` for application logs
- **Health:** Visit `/indianhistorybite/api/scheduler-status` for system status
- **Costs:** Monitor Claude API usage in logs for cost tracking

### Troubleshooting

**Common Issues:**

1. **API Key Issues:**
   - Ensure your Claude API key is valid and has sufficient credits
   - Check the logs for authentication errors

2. **Port Conflicts:**
   - Change the PORT in `.env` if 3001 is occupied
   - Update your reverse proxy configuration accordingly

3. **VAPID Keys:**
   - Generate VAPID keys using `generate-vapid-keys.js` if needed
   - Ensure HTTPS is enabled for production

4. **Service Worker Issues:**
   - Clear browser cache and reload
   - Check browser console for errors

### Security Considerations

- Never commit `.env` or `vapid-keys.env` files
- Use strong, random values for `APP_API_KEY`
- Enable HTTPS in production
- Regularly update dependencies: `npm audit fix`
- Monitor Claude API usage to prevent unexpected costs

### API Endpoints

- `GET /indianhistorybite/` - Main app interface
- `GET /indianhistorybite/api/result` - Get current story
- `POST /indianhistorybite/api/refresh` - Generate new story (requires auth)
- `POST /indianhistorybite/api/subscribe` - Subscribe endpoint
- `GET /indianhistorybite/api/scheduler-status` - System status (requires auth)

## Configuration Options

The app requires:
- **Claude API key** for story generation (required)
- **VAPID keys** (optional)
- **App API key** for securing admin endpoints (optional)

See `.env.example` for all available environment variables.

## License

MIT License - see [LICENSE](LICENSE) file for details.