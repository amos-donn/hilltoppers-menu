/**
 * CORS helpers for the ratings API.
 *
 * The widget is embedded in iframes on other sites and can also be opened
 * directly, so no origin list is maintained; only the rater id header is
 * allowed, and no cookies or credentials are used.
 */

const ALLOWED_HEADERS = 'Content-Type, X-Rater-ID';

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400'
  };
}

export function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
