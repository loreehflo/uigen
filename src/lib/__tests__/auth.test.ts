import { test, expect, vi, beforeEach, describe } from "vitest";

const { cookieStore, cookieMock } = vi.hoisted(() => {
  const store = new Map<string, { value: string; options?: Record<string, unknown> }>();
  return {
    cookieStore: store,
    cookieMock: {
      get: vi.fn((name: string) => {
        const entry = store.get(name);
        return entry ? { name, value: entry.value } : undefined;
      }),
      set: vi.fn((name: string, value: string, options?: Record<string, unknown>) => {
        store.set(name, { value, options });
      }),
      delete: vi.fn((name: string) => {
        store.delete(name);
      }),
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieMock),
}));

import { SignJWT } from "jose";
import { NextRequest } from "next/server";
import {
  createSession,
  getSession,
  deleteSession,
  verifySession,
} from "@/lib/auth";

const SECRET = new TextEncoder().encode("development-secret-key");
const COOKIE_NAME = "auth-token";

beforeEach(() => {
  cookieStore.clear();
  cookieMock.get.mockClear();
  cookieMock.set.mockClear();
  cookieMock.delete.mockClear();
});

describe("createSession", () => {
  test("sets an auth-token cookie with httpOnly, sameSite=lax, and path=/", async () => {
    await createSession("user-1", "alice@example.com");

    expect(cookieMock.set).toHaveBeenCalledTimes(1);
    const [name, token, options] = cookieMock.set.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>
    ];
    expect(name).toBe(COOKIE_NAME);
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.expires).toBeInstanceOf(Date);
  });

  test("expires roughly 7 days in the future", async () => {
    const before = Date.now();
    await createSession("user-1", "alice@example.com");
    const [, , options] = cookieMock.set.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>
    ];
    const expires = (options.expires as Date).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(expires - before).toBeGreaterThanOrEqual(sevenDays - 1000);
    expect(expires - before).toBeLessThanOrEqual(sevenDays + 1000);
  });

  test("token verifies with the secret and contains userId + email", async () => {
    await createSession("user-42", "bob@example.com");
    const token = cookieStore.get(COOKIE_NAME)!.value;
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(token, SECRET);
    expect(payload.userId).toBe("user-42");
    expect(payload.email).toBe("bob@example.com");
  });

  test("secure flag is false outside production", async () => {
    await createSession("u", "e@example.com");
    const [, , options] = cookieMock.set.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>
    ];
    expect(options.secure).toBe(false);
  });
});

describe("getSession", () => {
  test("returns null when no cookie is present", async () => {
    expect(await getSession()).toBeNull();
  });

  test("returns null when the cookie has a malformed token", async () => {
    cookieStore.set(COOKIE_NAME, { value: "not.a.jwt" });
    expect(await getSession()).toBeNull();
  });

  test("returns null when the token is signed with a different secret", async () => {
    const wrong = new TextEncoder().encode("a-different-secret");
    const token = await new SignJWT({ userId: "u", email: "e@x" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("7d")
      .setIssuedAt()
      .sign(wrong);
    cookieStore.set(COOKIE_NAME, { value: token });
    expect(await getSession()).toBeNull();
  });

  test("returns null when the token is expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ userId: "u", email: "e@x" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(now - 60)
      .setIssuedAt(now - 3600)
      .sign(SECRET);
    cookieStore.set(COOKIE_NAME, { value: token });
    expect(await getSession()).toBeNull();
  });

  test("returns the payload for a valid token created by createSession", async () => {
    await createSession("user-7", "carol@example.com");
    const session = await getSession();
    expect(session).not.toBeNull();
    expect(session!.userId).toBe("user-7");
    expect(session!.email).toBe("carol@example.com");
  });
});

describe("deleteSession", () => {
  test("deletes the auth-token cookie", async () => {
    cookieStore.set(COOKIE_NAME, { value: "anything" });
    await deleteSession();
    expect(cookieMock.delete).toHaveBeenCalledWith(COOKIE_NAME);
  });
});

describe("verifySession", () => {
  function makeRequest(cookieValue?: string): NextRequest {
    const headers = new Headers();
    if (cookieValue !== undefined) {
      headers.set("cookie", `${COOKIE_NAME}=${cookieValue}`);
    }
    return new NextRequest("http://localhost/", { headers });
  }

  test("returns null when the request has no auth cookie", async () => {
    expect(await verifySession(makeRequest())).toBeNull();
  });

  test("returns null when the cookie has a malformed token", async () => {
    expect(await verifySession(makeRequest("not.a.jwt"))).toBeNull();
  });

  test("returns null when the token is signed with a different secret", async () => {
    const wrong = new TextEncoder().encode("a-different-secret");
    const token = await new SignJWT({ userId: "u", email: "e@x" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("7d")
      .setIssuedAt()
      .sign(wrong);
    expect(await verifySession(makeRequest(token))).toBeNull();
  });

  test("returns the payload for a valid token", async () => {
    const token = await new SignJWT({ userId: "u-9", email: "dan@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("7d")
      .setIssuedAt()
      .sign(SECRET);
    const session = await verifySession(makeRequest(token));
    expect(session).not.toBeNull();
    expect(session!.userId).toBe("u-9");
    expect(session!.email).toBe("dan@example.com");
  });
});
