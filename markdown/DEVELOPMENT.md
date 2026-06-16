# Development Guide

## Frontend Development

### Environment Setup

The frontend uses environment variables to configure the API endpoint for development.

1. **Automatic Setup (Recommended)**
   ```bash
   ./deploy.sh  # This automatically creates frontend/.env.local with the correct API URL
   ```

2. **Manual Setup**
   ```bash
   cp frontend/.env.example frontend/.env.local
   # Edit frontend/.env.local and set VITE_API_URL to your API Gateway URL
   ```

### Running Development Server

```bash
cd frontend
npm run dev
```

The development server will:
- Run on `http://localhost:3000`
- Proxy `/api` requests to your deployed API Gateway
- Use the API URL from `VITE_API_URL` environment variable

### Configuration Files

- `vite.config.ts.template` - Template for Vite configuration (commit this)
- `vite.config.ts` - Generated from template (do not commit)
- `.env.local` - Local environment variables (do not commit)
- `.env.example` - Example environment file (commit this)

### Important Notes

- Never commit `frontend/.env.local` or hardcoded API URLs
- The deploy script automatically updates your local environment
- Use `process.env.VITE_API_URL` in vite.config.ts for the proxy target
