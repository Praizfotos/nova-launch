/**
 * Tests for #1101: Cursor-based pagination on analytics list endpoints.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import analyticsRouter, { clearCache } from "../routes/analytics";
import { Database } from "../config/database";
import { AuthRequest } from "../middleware/auth";
import { CursorPagination } from "../lib/pagination";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../config/database", () => ({
  Database: {
    getAllTokens: vi.fn(),
    getAllUsers: vi.fn(),
  },
}));

vi.mock("../middleware/auth", () => ({
  authenticateAdmin: (
    req: AuthRequest,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.admin = {
      id: "admin_1",
      role: "super_admin",
      banned: false,
      stellarAddress: "GADMIN",
      createdAt: new Date(),
    } as any;
    next();
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = Date.now();
const DAY = 86_400_000;

// 5 tokens with distinct createdAt values so ordering is deterministic
const mockTokens = [
  { id: "t1", name: "Alpha", symbol: "ALP", creator: "GC1", burned: "100", createdAt: new Date(now - 1 * DAY), deleted: false },
  { id: "t2", name: "Beta",  symbol: "BET", creator: "GC2", burned: "200", createdAt: new Date(now - 2 * DAY), deleted: false },
  { id: "t3", name: "Gamma", symbol: "GAM", creator: "GC1", burned: "300", createdAt: new Date(now - 3 * DAY), deleted: false },
  { id: "t4", name: "Delta", symbol: "DEL", creator: "GC3", burned: "400", createdAt: new Date(now - 4 * DAY), deleted: false },
  { id: "t5", name: "Epsilon", symbol: "EPS", creator: "GC2", burned: "500", createdAt: new Date(now - 5 * DAY), deleted: false },
];

const mockUsers = [
  { id: "u1", banned: false, createdAt: new Date(now - 1 * DAY) },
  { id: "u2", banned: true,  createdAt: new Date(now - 2 * DAY) },
  { id: "u3", banned: false, createdAt: new Date(now - 3 * DAY) },
  { id: "u4", banned: false, createdAt: new Date(now - 4 * DAY) },
  { id: "u5", banned: true,  createdAt: new Date(now - 5 * DAY) },
];

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/analytics", analyticsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Tests — /tokens/list
// ---------------------------------------------------------------------------

describe("GET /api/analytics/tokens/list (#1101)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    vi.mocked(Database.getAllTokens).mockResolvedValue(mockTokens as any);
    vi.mocked(Database.getAllUsers).mockResolvedValue(mockUsers as any);
  });

  it("returns 200 with paginated token list", async () => {
    const res = await request(buildApp()).get("/api/analytics/tokens/list");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(Array.isArray(data.items)).toBe(true);
    expect(data).toHaveProperty("nextCursor");
    expect(data).toHaveProperty("prevCursor");
    expect(data).toHaveProperty("hasNextPage");
    expect(data).toHaveProperty("total");
  });

  it("returns all 5 tokens when limit is large enough", async () => {
    const res = await request(buildApp()).get("/api/analytics/tokens/list?limit=10");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(5);
    expect(res.body.data.hasNextPage).toBe(false);
    expect(res.body.data.nextCursor).toBeNull();
  });

  it("orders results by createdAt DESC (newest first)", async () => {
    const res = await request(buildApp()).get("/api/analytics/tokens/list?limit=10");
    const ids: string[] = res.body.data.items.map((t: any) => t.id);
    // t1 newest → t5 oldest
    expect(ids).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  it("respects the limit parameter and returns a cursor for the next page", async () => {
    const res = await request(buildApp()).get("/api/analytics/tokens/list?limit=2");
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.items).toHaveLength(2);
    expect(data.items[0].id).toBe("t1");
    expect(data.items[1].id).toBe("t2");
    expect(data.hasNextPage).toBe(true);
    expect(typeof data.nextCursor).toBe("string");
  });

  it("uses the cursor to fetch the next page without overlap", async () => {
    const app = buildApp();
    const page1 = await request(app).get("/api/analytics/tokens/list?limit=2");
    const cursor = page1.body.data.nextCursor;

    const page2 = await request(app).get(`/api/analytics/tokens/list?limit=2&cursor=${cursor}`);
    expect(page2.status).toBe(200);
    const ids1: string[] = page1.body.data.items.map((t: any) => t.id);
    const ids2: string[] = page2.body.data.items.map((t: any) => t.id);

    // No overlap
    const overlap = ids1.filter((id) => ids2.includes(id));
    expect(overlap).toHaveLength(0);
    expect(ids2[0]).toBe("t3");
  });

  it("returns empty items and no cursor when the list is empty", async () => {
    vi.mocked(Database.getAllTokens).mockResolvedValue([]);
    const res = await request(buildApp()).get("/api/analytics/tokens/list");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(0);
    expect(res.body.data.hasNextPage).toBe(false);
    expect(res.body.data.nextCursor).toBeNull();
    expect(res.body.data.total).toBe(0);
  });

  it("returns 400 for an invalid limit value", async () => {
    const res = await request(buildApp()).get("/api/analytics/tokens/list?limit=0");
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed cursor", async () => {
    const res = await request(buildApp()).get("/api/analytics/tokens/list?cursor=!!!invalid!!!");
    expect(res.status).toBe(400);
  });

  it("returns 500 when database throws", async () => {
    vi.mocked(Database.getAllTokens).mockRejectedValue(new Error("db down"));
    const res = await request(buildApp()).get("/api/analytics/tokens/list");
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Tests — /users/list
// ---------------------------------------------------------------------------

describe("GET /api/analytics/users/list (#1101)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    vi.mocked(Database.getAllTokens).mockResolvedValue(mockTokens as any);
    vi.mocked(Database.getAllUsers).mockResolvedValue(mockUsers as any);
  });

  it("returns 200 with paginated user list", async () => {
    const res = await request(buildApp()).get("/api/analytics/users/list");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(Array.isArray(data.items)).toBe(true);
    expect(data).toHaveProperty("hasNextPage");
    expect(data).toHaveProperty("total");
  });

  it("orders results by createdAt DESC (newest first)", async () => {
    const res = await request(buildApp()).get("/api/analytics/users/list?limit=10");
    const ids: string[] = res.body.data.items.map((u: any) => u.id);
    expect(ids).toEqual(["u1", "u2", "u3", "u4", "u5"]);
  });

  it("forward pagination does not overlap pages", async () => {
    const app = buildApp();
    const page1 = await request(app).get("/api/analytics/users/list?limit=2");
    const cursor = page1.body.data.nextCursor;

    const page2 = await request(app).get(`/api/analytics/users/list?limit=2&cursor=${cursor}`);
    const ids1: string[] = page1.body.data.items.map((u: any) => u.id);
    const ids2: string[] = page2.body.data.items.map((u: any) => u.id);

    const overlap = ids1.filter((id) => ids2.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it("returns empty list and hasNextPage=false for empty dataset", async () => {
    vi.mocked(Database.getAllUsers).mockResolvedValue([]);
    const res = await request(buildApp()).get("/api/analytics/users/list");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(0);
    expect(res.body.data.hasNextPage).toBe(false);
  });

  it("returns 500 when database throws", async () => {
    vi.mocked(Database.getAllUsers).mockRejectedValue(new Error("db down"));
    const res = await request(buildApp()).get("/api/analytics/users/list");
    expect(res.status).toBe(500);
  });
});
