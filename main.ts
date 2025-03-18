// -*- mode: typescript-ts -*-
import { serveFile } from "jsr:@std/http/file-server";
import { match, P } from "jsr:@gabriel/ts-pattern";

// The builtin base64 api is still unimplemented in v8.
import { encodeBase64Url, decodeBase64Url } from "jsr:@std/encoding/base64url";

const FILE = new URLPattern({ pathname: "/:id" });
const KV = await Deno.openKv();

// Routing Entry
const handler = (req: Request): Response | Promise<Response> => match([req.method, new URL(req.url)])
  // GET https://example.com/ returns the index.html static page.
  .with(["GET", { pathname: "/" }], () => serveFile(req, "./index.html"))
  // GET https://example.com/:id
  // Parse url with the FILE URLPattern. If Success, check if :id is valid.
  .with(["GET", P.when((url) => FILE.test(url))], ([_, url]) => match(FILE.exec(url)?.pathname.groups.id)
    // First, when :id is a valid base64 string, make a query to database.
    // See `asKey(String): Uint8Array | undefined` for validation details.
    .with(P.string, (id) => match(asKey(id))
      // Get query result with KV.get().
      .with(P.instanceOf(Uint8Array), async (key) => match((await KV.get([key])).value)
	// Returns the value when the query matches a key-value pair.
	.with(P.string, (value) => new Response(value, { status: 200 }))
	// Returns a 404 Not Found response when the required text doesn't exist.
	.with(null, () => new Response("Not Found", { status: 404 }))
	// Value of the matched key-value pair is not of a string. This should not happen.
	// Returns a 500 Internal Server Error on this case.
	.otherwise(() => new Response("Malformed Data", { status: 500 }))
      )
      // :id is an invalid base64 string.
      // See `asKey(String): Uint8Array | undefined` for validation details.
      .with(undefined, () => new Response("Invalid URL", { status: 400 }))
      .exhaustive()
    )
    // Can't parses an :id from URL.
    // This should be unreachable since the URL is already checked by FILE.test() predicate.
    // (Just to make type checker happy.)
    .with(undefined, () => new Response("Internal Server Error", { status: 500 }))
    .exhaustive()
  )
  // POST text
  // To upload the text onto server uses a POST request at root endpoint "/".
  // The request body will be saved and the access key is returned in response body as plain text.
  .with(["POST", { pathname: "/" }], async () => {
    // Find an available place for the incoming text. The place is defines by a random generated number. See more
    // details about the random number generation in `randomKey(): Uint8Array`.
    //
    // A random number should be very enough. Gonna run out of space before two random number happens to be the same.
    // I'll clear up the database when there's too many entries, anyway.
    const key = randomKey();
    await KV.set([key], await req.text());
    return new Response(encodeBase64Url(key), { status: 201 });
  })
  // DELETE https://example.com/:id
  // To delete the text under :id uses a DELETE request at endpoint "/:id".
  // Returns 200 OK if success, 404 NotFound otherwise.
  //
  // The same logic as GET :id. Check the url first, then decode with base64, finally querying the database.
  .with(["DELETE", P.when((url) => FILE.test(url))], ([_, url]) => match(FILE.exec(url)?.pathname.groups.id)
    .with(P.string, (id) => match(asKey(id))
      .with(P.instanceOf(Uint8Array), async (key) => {
	// We can just silently process everything, but for better user experience we query for existence first.
	if ((await KV.get([key])).value == null) {
	  return new Response("Not Found", { status: 404 });
	} else {
	  await KV.delete([key]);
	  return new Response("Deleted", { status: 200 });
	}
      })
      // Invlid :id in URL pattern. See GET :id batch for details.
      .with(undefined, () => new Response("Invalid URL", { status: 400 }))
      .exhaustive()
    )
    // Unreachable. See GET :id batch for details.
    .with(undefined, () => new Response("Internal Server Error", { status: 500 }))
    .exhaustive()
  )
  // 404 Not Found for all other cases.
  .otherwise(() => new Response("Not Found", { status: 404 }))

// Returns a random number between [0, 2**48), represented by a 6-bytes-long Uint8Array.
function randomKey(): Uint8Array {
  const result = new Uint8Array(6);
  crypto.getRandomValues(result);
  return result;
}

function asKey(id: string): Uint8Array | undefined {
  try {
    const buf = decodeBase64Url(id);
    // Our random key will not exceed 6 bytes long. When that happens mark it as invalid.
    return buf.length <= 6 ? buf : undefined;
  } catch (_) {
    // A syntax error will be threw if it's not base64-encoded.
    return undefined;
  }
}

Deno.serve(handler);
