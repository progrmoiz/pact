import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { createServer } from 'http';
import { URL } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = join(homedir(), '.pact', 'gmail-credentials.json');
const REDIRECT_PORT = 3000;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

export function getOAuth2Client(): OAuth2Client {
  const clientId = process.env.PACT_GMAIL_CLIENT_ID;
  const clientSecret = process.env.PACT_GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Gmail OAuth not configured. Set PACT_GMAIL_CLIENT_ID and PACT_GMAIL_CLIENT_SECRET.\n' +
      'Run "pact init gmail" for setup instructions.'
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

export function hasCredentials(): boolean {
  return existsSync(TOKEN_PATH);
}

export function loadCredentials(): OAuth2Client {
  const client = getOAuth2Client();

  if (!existsSync(TOKEN_PATH)) {
    throw new Error('Gmail not authenticated. Run "pact init gmail" first.');
  }

  const tokens = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
  client.setCredentials(tokens);

  // Set up auto-refresh: save new tokens when refreshed
  client.on('tokens', (newTokens) => {
    const existing = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
    const merged = { ...existing, ...newTokens };
    writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });

  return client;
}

export async function authenticate(): Promise<void> {
  const client = getOAuth2Client();

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\nOpen this URL in your browser:\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization...');

  // Try to open browser automatically
  const { exec } = await import('child_process');
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${authUrl}"`);

  // Start local server to catch the redirect
  const code = await new Promise<string>((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization failed</h1><p>You can close this tab.</p>');
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Pact connected to Gmail!</h1><p>You can close this tab.</p>');
        clearTimeout(timeout);
        server.close();
        resolve(code);
      }
    });

    server.listen(REDIRECT_PORT, () => {
      // Server listening
    });

    // Timeout after 2 minutes
    timeout = setTimeout(() => {
      server.close();
      reject(new Error('Authorization timed out after 2 minutes'));
    }, 120000);
    timeout.unref(); // Don't keep process alive
  });

  // Exchange code for tokens
  const { tokens } = await client.getToken(code);

  // Save tokens
  const dir = join(homedir(), '.pact');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

  console.log('\nGmail connected successfully!');
}
