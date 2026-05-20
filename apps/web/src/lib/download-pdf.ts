import toast from 'react-hot-toast';

import { API_PREFIX, API_URL } from './env';
import { useAuth } from './auth-store';

// =============================================================================
// downloadPdf — fetch a bearer-authenticated PDF endpoint and trigger a file
// download in the browser.
//
// Why not just `window.location = url`? Because our API requires an
// Authorization: Bearer <jwt> header on every protected route. A plain
// navigation doesn't carry the header, so the request would 401. We fetch
// with the right header, build a Blob from the response, and click a
// synthetic <a download> to save it.
//
// Errors surface as a toast — same UX as the rest of the app's mutations.
// =============================================================================

export async function downloadPdf(path: string, filename: string): Promise<void> {
  const token = useAuth.getState().tokens?.accessToken;
  if (!token) {
    toast.error('Sign in again to download the report.');
    return;
  }
  const url = `${API_URL}${API_PREFIX}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    toast.error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      /* response wasn't JSON — keep the status line as the detail */
    }
    toast.error(`Could not download: ${detail}`);
    return;
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so Chrome can finish kicking off the download.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
