// Local fake of the LinkedIn endpoints we use, implementing the documented contract
// (research/raw-linkedin-phase2-implementation.md). Never contacts LinkedIn.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type PostBehaviour =
  | "created" | "created_no_id" | "hang" | "destroy"
  | 400 | 401 | 403 | 409 | 422 | 426 | 429 | 500 | 503;

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface FakeLinkedIn {
  base: string;
  requests: RecordedRequest[];
  posts: Array<{ id: string; author: string; commentary: string; createdAt: number }>;
  behaviour: { post: PostBehaviour };
  /** Access tokens the fake will accept. */
  validTokens: Set<string>;
  issuedToken: string;
  sub: string;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });

export async function startFakeLinkedIn(): Promise<FakeLinkedIn> {
  const state: Omit<FakeLinkedIn, "base" | "close"> = {
    requests: [], posts: [], behaviour: { post: "created" }, validTokens: new Set(),
    issuedToken: `AQX_fake_access_token_${"x".repeat(60)}`, sub: "abc123XYZ",
  };
  let seq = 7000000000000000000n;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? "/", "http://fake");
    state.requests.push({ method: req.method ?? "", path: url.pathname + url.search, headers: req.headers, body });
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");

    if (req.method === "GET" && url.pathname === "/oauth/v2/authorization") {
      // Simulates the member consenting: redirect back to the app with a code and the same state.
      const back = new URL(url.searchParams.get("redirect_uri") ?? "http://invalid/");
      back.searchParams.set("code", "good-code");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/oauth/v2/accessToken") {
      const p = new URLSearchParams(body);
      if (p.get("grant_type") !== "authorization_code" || p.get("code") !== "good-code" || !p.get("client_secret")) {
        return json(400, { error: "invalid_request" });
      }
      state.validTokens.add(state.issuedToken);
      return json(200, { access_token: state.issuedToken, expires_in: 5183999, scope: "openid,profile,w_member_social" });
    }
    if (req.method === "POST" && url.pathname === "/oauth/v2/introspectToken") {
      const p = new URLSearchParams(body);
      if (!p.get("client_id") || !p.get("client_secret")) return json(401, { message: "client auth required" });
      const active = state.validTokens.has(p.get("token") ?? "");
      return json(200, active
        ? { active: true, client_id: p.get("client_id"), status: "active", expires_at: Math.floor(Date.now() / 1000) + 5_000_000, scope: "openid,profile,w_member_social" }
        : { active: false });
    }
    if (req.method === "GET" && url.pathname === "/v2/userinfo") {
      if (!state.validTokens.has(bearer)) return json(401, { message: "Invalid access token" });
      return json(200, { sub: state.sub, name: "Test Profile at Example", email_verified: false });
    }
    if (req.method === "POST" && url.pathname === "/v2/ugcPosts") {
      if (req.headers["x-restli-protocol-version"] !== "2.0.0") return json(400, { message: "bad protocol version" });
      const b = state.behaviour.post;
      if (b === "hang") return;
      if (b === "destroy") { req.socket.destroy(); return; }
      if (!state.validTokens.has(bearer)) return json(401, { message: "Invalid access token" });
      const post = JSON.parse(body) as { author: string; specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text: string } } } };
      const text = post.specificContent["com.linkedin.ugc.ShareContent"].shareCommentary.text;
      if (b === "created" || b === "created_no_id") {
        const id = `urn:li:share:${seq++}`;
        state.posts.push({ id, author: post.author, commentary: text, createdAt: Date.now() });
        res.writeHead(201, b === "created" ? { "X-RestLi-Id": id } : {});
        return res.end(JSON.stringify(b === "created" ? { id } : {}));
      }
      if (b === 429) return json(429, { message: "Too many requests" }, { "retry-after": "120" });
      if (b === 500 || b === 503) state.posts.push({ id: `urn:li:share:${seq++}`, author: post.author, commentary: text, createdAt: Date.now() });
      return json(b, { message: `fake ${b}` });
    }
    if (url.pathname === "/rest/posts") {
      if (!req.headers["linkedin-version"]) return json(400, { message: "Missing LinkedIn-Version header" });
      if (req.headers["x-restli-protocol-version"] !== "2.0.0") return json(400, { message: "bad protocol version" });
      if (req.method === "GET") {
        const author = url.searchParams.get("author");
        return json(200, { elements: state.posts.filter((p) => p.author === author).map((p) => ({ id: p.id, commentary: p.commentary, createdAt: p.createdAt })) });
      }
      const b = state.behaviour.post;
      if (b === "hang") return; // never respond → client timeout
      if (b === "destroy") { req.socket.destroy(); return; }
      if (!state.validTokens.has(bearer)) return json(401, { message: "Invalid access token" });
      const post = JSON.parse(body) as { author: string; commentary: string };
      if (b === "created" || b === "created_no_id") {
        const id = `urn:li:share:${seq++}`;
        state.posts.push({ id, author: post.author, commentary: post.commentary, createdAt: Date.now() });
        res.writeHead(201, b === "created" ? { "x-restli-id": id } : {});
        return res.end();
      }
      if (b === 429) return json(429, { message: "Too many requests" }, { "retry-after": "120" });
      if (b === 500 || b === 503) {
        // Worst case for a real API: the post was created but the response failed.
        state.posts.push({ id: `urn:li:share:${seq++}`, author: post.author, commentary: post.commentary, createdAt: Date.now() });
      }
      return json(b, { message: `fake ${b}` });
    }
    json(404, { message: "not found" });
  };

  const server: Server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ...state,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
