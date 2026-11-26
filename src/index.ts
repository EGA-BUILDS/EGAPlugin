const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

export function handleRequest(request: Request): Response {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return new Response(
      JSON.stringify({
        status: "ok",
        service: "ega-plugin",
        spec: "SPEC-001 Revision 6",
        phase: "bootstrap",
      }),
      { status: 200, headers: JSON_HEADERS }
    );
  }

  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: JSON_HEADERS,
  });
}

const worker: ExportedHandler = {
  fetch(request: Request): Response {
    return handleRequest(request);
  },
};

export default worker;
