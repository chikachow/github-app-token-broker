interface ProblemDetails {
  status: number;
  title: string;
  type: string;
}

const statusTitles = new Map<number, string>([
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [405, "Method Not Allowed"],
  [413, "Payload Too Large"],
  [415, "Unsupported Media Type"],
  [429, "Too Many Requests"],
  [500, "Internal Server Error"],
  [502, "Bad Gateway"],
]);

function problemDetails(status: number): ProblemDetails {
  return {
    status,
    title: statusTitles.get(status) ?? "Unknown Error",
    type: "about:blank",
  };
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function problemResponse(status: number, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/problem+json; charset=utf-8");

  return new Response(JSON.stringify(problemDetails(status)), {
    status,
    headers: responseHeaders,
  });
}
