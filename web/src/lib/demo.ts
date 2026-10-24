import { config } from './config';

/** Demo controls are POSTs to the server (`DEMO_CONTROLS=true`). Returns the JSON body or throws its error. */
export async function demo<T = unknown>(path: string, body: object = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}/demo/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.demoKey ? { 'x-demo-key': config.demoKey } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Server not reachable at ${config.apiUrl}. Run pnpm dev with the .env tokens.`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (json as { error?: unknown }).error;
    throw new Error(typeof error === 'string' ? error : `${path} failed (${res.status})`);
  }
  return json as T;
}
