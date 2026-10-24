/** Render appends the observed address to XFF; prefixes are caller controlled. */
export function clientIp(request: Pick<Request, "headers">): string {
  return request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("true-client-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
    || "unknown";
}
