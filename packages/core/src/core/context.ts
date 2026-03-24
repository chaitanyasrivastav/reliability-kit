/**
 * Framework-agnostic representation of an incoming HTTP request.
 *
 * Shared across all reliability modules and the request handler during
 * a single request lifecycle. Modules read from it to make decisions
 * (idempotency reads headers, logging reads method and path) and write
 * to it to communicate results back to the adapter (idempotency writes
 * response and statusCode, which the Express adapter flushes to res).
 *
 * Deliberately minimal — only the fields reliability modules actually
 * need. Framework-specific concepts (e.g. Express's req.params,
 * req.cookies, req.ip) are intentionally absent. If a module needs
 * additional data, it should be added here with a clear use case rather
 * than leaking framework types into the core.
 *
 * Mutability is intentional: modules write response and statusCode to
 * signal their outcome to the adapter. The last write wins — later
 * modules in the chain can overwrite earlier ones, though the engine's
 * ctx.response guard prevents most accidental overwrites.
 */
export interface RequestContext {
  /**
   * HTTP method of the incoming request.
   * Uppercase by convention — 'GET', 'POST', 'PUT', 'DELETE', etc.
   * Used by logging and potentially by future routing-aware modules.
   */
  method: string

  /**
   * URL path of the incoming request, without query string.
   * e.g. '/orders', '/payments/123'
   * Used by logging and potentially by future rate-limiting modules.
   */
  path: string

  /**
   * HTTP request headers as a key-value map.
   *
   * Values are typed as string | string[] | undefined to match
   * Node.js's IncomingHttpHeaders — HTTP allows multi-value headers
   * (e.g. multiple Set-Cookie entries arrive as string[]).
   *
   * Idempotency reads this to extract the idempotency key header.
   * The module handles the string[] case by taking the first value.
   *
   * Optional — some internal or test contexts may not provide headers.
   * Modules that read headers must handle the undefined case gracefully.
   */
  headers?: Record<string, string | string[] | undefined>

  /**
   * Parsed request body.
   *
   * Typed as unknown — the library has no knowledge of the shape of
   * the request body. Modules or handlers that need the body must
   * cast or validate it against their own expected type.
   *
   * Optional — not all requests have a body (GET, DELETE, HEAD).
   */
  body?: unknown

  /**
   * HTTP status code to send in the response.
   *
   * Written by modules that short-circuit the chain (e.g. idempotency
   * writes 409 for in-progress requests, or the cached statusCode for
   * duplicate requests). Also captured from the handler's response by
   * the framework adapter's res.send/json/end interception.
   *
   * Read by the adapter at the end of the request to flush the correct
   * status code to the framework's response object. Defaults to 200
   * in the adapter if not set.
   */
  statusCode?: number

  /**
   * Response body to send to the client.
   *
   * Written by modules that short-circuit (e.g. idempotency writes the
   * cached response body or an error object). Also captured from the
   * handler by the framework adapter's response interception.
   *
   * The adapter checks ctx.response !== undefined after the engine
   * completes — if set and headers haven't been sent yet, the adapter
   * flushes this value to the client. If the handler already sent a
   * response, this field is populated but ignored by the adapter.
   *
   * Typed as unknown for the same reason as body — the library does
   * not know or enforce the shape of handler responses.
   */
  response?: unknown
}

/**
 * Framework-agnostic representation of an outgoing HTTP response.
 *
 * Currently unused in the core engine — response state is written
 * directly to RequestContext (ctx.response, ctx.statusCode) rather
 * than to a separate ResponseContext. This interface is reserved for
 * future use when more granular response control is needed, such as
 * setting response headers from within a module (e.g. rate limiting
 * writing X-RateLimit-* headers, or CORS headers from a future module).
 *
 * When response header support is added to modules, this interface
 * will be the correct place to carry that state rather than mixing
 * response headers into RequestContext.headers.
 */
export interface ResponseContext {
  /**
   * HTTP status code for the outgoing response.
   */
  status?: number

  /**
   * Response body — typed as unknown since the library does not
   * enforce a shape on handler responses.
   */
  body?: unknown

  /**
   * Response headers to set on the outgoing response.
   * Typed as Record<string, string> — response header values are
   * always single strings (unlike request headers which can be arrays).
   */
  headers?: Record<string, string>
}
