/**
 * Audit Log Completeness Integration Tests
 *
 * Validates that the auditLog middleware records every sensitive admin action
 * with complete metadata and no sensitive data in plaintext.
 *
 * Strategy:
 *   - Assert successful admin actions write complete audit entries
 *   - Assert failed/denied actions are also recorded
 *   - Assert no duplicate entries per request
 *   - Verify sensitive fields are not logged in plaintext
 */

import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { auditLog } from "../middleware/auditLog";
import { Database } from "../config/database";

// ── Constants ──────────────────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /key/i,
  /credential/i,
  /private/i,
];

// ── In-memory audit log store ──────────────────────────────────────────────

interface AuditLogEntry {
  adminId: string;
  action: string;
  resource: string;
  resourceId: string;
  beforeState: any;
  afterState: any;
  ipAddress: string;
  userAgent: string;
  timestamp: Date;
}

let auditLogs: AuditLogEntry[] = [];

// Mock Database.createAuditLog
vi.spyOn(Database, "createAuditLog").mockImplementation(async (entry) => {
  auditLogs.push({
    ...entry,
    timestamp: new Date(),
  });
  return { id: uuidv4() };
});

// Mock Database.findTokenById and findUserById
vi.spyOn(Database, "findTokenById").mockImplementation(async (id) => {
  if (id === "token-to-update") {
    return {
      id,
      address: "GTOKEN_AUDIT_TEST",
      name: "Old Name",
      symbol: "OLD",
      decimals: 7,
    };
  }
  return null;
});

vi.spyOn(Database, "findUserById").mockImplementation(async (id) => {
  if (id === "user-to-update") {
    return {
      id,
      email: "old@example.com",
      role: "user",
    };
  }
  return null;
});

// ── Test Fixtures ─────────────────────────────────────────────────────────

function createMockRequest(
  method: string = "POST",
  params: any = {},
  admin: any = null
): Partial<Request> {
  return {
    method,
    params,
    admin: admin || {
      id: `admin-${uuidv4()}`,
      email: "admin@example.com",
    },
    ip: "192.168.1.100",
    socket: { remoteAddress: "192.168.1.100" } as any,
    headers: {
      "user-agent": "Mozilla/5.0 (Test)",
    },
  };
}

function createMockResponse(): Partial<Response> {
  const res: any = {
    json: vi.fn(function (data: any) {
      return this;
    }),
  };
  return res;
}

function createMockNext(): NextFunction {
  return vi.fn();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Audit Log Completeness for Admin Actions", () => {
  beforeEach(() => {
    auditLogs = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Successful Admin Actions", () => {
    it("should write complete audit entry for POST action", async () => {
      const middleware = auditLog("create_token", "token");
      const req = createMockRequest("POST", { id: "new-token" }, {
        id: "admin-123",
        email: "admin@test.com",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      const tokenData = {
        address: "GTOKEN_NEW",
        name: "New Token",
        symbol: "NEW",
        decimals: 7,
      };

      await middleware(req as any, res, next);

      // Simulate response
      res.json(tokenData);

      expect(auditLogs).toHaveLength(1);
      const entry = auditLogs[0];

      expect(entry.adminId).toBe("admin-123");
      expect(entry.action).toBe("POST create_token");
      expect(entry.resource).toBe("token");
      expect(entry.afterState).toEqual(tokenData);
      expect(entry.ipAddress).toBe("192.168.1.100");
      expect(entry.userAgent).toBe("Mozilla/5.0 (Test)");
    });

    it("should capture before and after state for PATCH action", async () => {
      const middleware = auditLog("update_token", "token");
      const req = createMockRequest("PATCH", { id: "token-to-update" }, {
        id: "admin-456",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      const updatedData = {
        id: "token-to-update",
        address: "GTOKEN_AUDIT_TEST",
        name: "New Name",
        symbol: "NEW",
        decimals: 7,
      };

      res.json(updatedData);

      expect(auditLogs).toHaveLength(1);
      const entry = auditLogs[0];

      expect(entry.beforeState).toBeTruthy();
      expect(entry.beforeState.name).toBe("Old Name");
      expect(entry.afterState).toEqual(updatedData);
      expect(entry.afterState.name).toBe("New Name");
    });

    it("should capture before state for DELETE action", async () => {
      const middleware = auditLog("delete_token", "token");
      const req = createMockRequest("DELETE", { id: "token-to-update" }, {
        id: "admin-789",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      res.json({ success: true });

      expect(auditLogs).toHaveLength(1);
      const entry = auditLogs[0];

      expect(entry.beforeState).toBeTruthy();
      expect(entry.beforeState.name).toBe("Old Name");
      expect(entry.action).toBe("DELETE delete_token");
    });

    it("should record complete metadata for successful action", async () => {
      const middleware = auditLog("admin_action", "token");
      const adminId = `admin-${uuidv4()}`;
      const req = createMockRequest("POST", { id: "token-1" }, { id: adminId });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      res.json({ id: "token-1", name: "Test" });

      expect(auditLogs[0]).toMatchObject({
        adminId,
        action: expect.any(String),
        resource: "token",
        resourceId: "token-1",
        ipAddress: expect.any(String),
        userAgent: expect.any(String),
      });
    });
  });

  describe("Failed/Denied Actions", () => {
    it("should record failed action attempt", async () => {
      const middleware = auditLog("update_token", "token");
      const req = createMockRequest("PATCH", { id: "nonexistent" }, {
        id: "admin-denied",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      // Simulate error response
      res.json({ error: "Token not found" });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].action).toBe("PATCH update_token");
    });

    it("should record denied action with authorization failure", async () => {
      const middleware = auditLog("delete_user", "user");
      const req = createMockRequest("DELETE", { id: "user-1" }, {
        id: "admin-limited",
        role: "viewer",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      res.json({ error: "Insufficient permissions" });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].action).toBe("DELETE delete_user");
    });
  });

  describe("No Duplicate Entries", () => {
    it("should write exactly one entry per request", async () => {
      const middleware = auditLog("create_token", "token");
      const req = createMockRequest("POST", { id: "token-1" }, {
        id: "admin-123",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      // Call json multiple times (shouldn't happen in practice, but test it)
      res.json({ id: "token-1" });
      res.json({ id: "token-1" });

      // Should still be exactly one log entry
      expect(auditLogs).toHaveLength(1);
    });

    it("should not duplicate on multiple middleware invocations", async () => {
      const middleware1 = auditLog("action1", "token");
      const middleware2 = auditLog("action2", "token");

      const req = createMockRequest("POST", { id: "token-1" }, {
        id: "admin-123",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware1(req as any, res, next);
      await middleware2(req as any, res, next);

      res.json({ id: "token-1" });

      // Each middleware should log once
      expect(auditLogs).toHaveLength(2);
    });
  });

  describe("Sensitive Data Protection", () => {
    it("should not log plaintext passwords", async () => {
      const middleware = auditLog("update_user", "user");
      const req = createMockRequest("PATCH", { id: "user-1" }, {
        id: "admin-123",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      const userData = {
        id: "user-1",
        email: "user@example.com",
        password: "super-secret-password-123",
      };

      res.json(userData);

      const entry = auditLogs[0];
      const logString = JSON.stringify(entry);

      // Password should not appear in plaintext
      expect(logString).not.toContain("super-secret-password-123");
    });

    it("should not log plaintext API keys", async () => {
      const middleware = auditLog("create_api_key", "token");
      const req = createMockRequest("POST", { id: "key-1" }, {
        id: "admin-123",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      const keyData = {
        id: "key-1",
        name: "Production Key",
        secret: "sk_live_abc123def456ghi789jkl",
      };

      res.json(keyData);

      const entry = auditLogs[0];
      const logString = JSON.stringify(entry);

      // Secret should not appear in plaintext
      expect(logString).not.toContain("sk_live_abc123def456ghi789jkl");
    });

    it("should not log plaintext private keys", async () => {
      const middleware = auditLog("import_key", "token");
      const req = createMockRequest("POST", { id: "key-1" }, {
        id: "admin-123",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      const keyData = {
        id: "key-1",
        privateKey: "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      };

      res.json(keyData);

      const entry = auditLogs[0];
      const logString = JSON.stringify(entry);

      // Private key should not appear in plaintext
      expect(logString).not.toContain("SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    });

    it("should not log plaintext credentials in beforeState", async () => {
      const middleware = auditLog("update_credentials", "user");
      const req = createMockRequest("PATCH", { id: "user-to-update" }, {
        id: "admin-123",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      // Mock a user with credentials
      vi.spyOn(Database, "findUserById").mockResolvedValueOnce({
        id: "user-to-update",
        email: "user@example.com",
        apiKey: "secret-api-key-12345",
      });

      await middleware(req as any, res, next);

      res.json({ id: "user-to-update", email: "user@example.com" });

      const entry = auditLogs[0];
      const logString = JSON.stringify(entry);

      // API key should not appear in plaintext
      expect(logString).not.toContain("secret-api-key-12345");
    });
  });

  describe("Admin Context", () => {
    it("should not log when no admin context", async () => {
      const middleware = auditLog("create_token", "token");
      const req = createMockRequest("POST", { id: "token-1" }, null);
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      res.json({ id: "token-1" });

      // Should not log if no admin
      expect(auditLogs).toHaveLength(0);
    });

    it("should record correct admin ID", async () => {
      const adminId = `admin-${uuidv4()}`;
      const middleware = auditLog("create_token", "token");
      const req = createMockRequest("POST", { id: "token-1" }, { id: adminId });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      res.json({ id: "token-1" });

      expect(auditLogs[0].adminId).toBe(adminId);
    });
  });

  describe("IP Address and User Agent", () => {
    it("should capture IP address from request", async () => {
      const middleware = auditLog("create_token", "token");
      const req = createMockRequest("POST", { id: "token-1" }, {
        id: "admin-123",
      });
      (req as any).ip = "203.0.113.42";
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      res.json({ id: "token-1" });

      expect(auditLogs[0].ipAddress).toBe("203.0.113.42");
    });

    it("should fallback to socket remoteAddress if ip not available", async () => {
      const middleware = auditLog("create_token", "token");
      const req = createMockRequest("POST", { id: "token-1" }, {
        id: "admin-123",
      });
      (req as any).ip = undefined;
      (req as any).socket.remoteAddress = "198.51.100.89";
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      res.json({ id: "token-1" });

      expect(auditLogs[0].ipAddress).toBe("198.51.100.89");
    });

    it("should capture user agent", async () => {
      const middleware = auditLog("create_token", "token");
      const req = createMockRequest("POST", { id: "token-1" }, {
        id: "admin-123",
      });
      (req as any).headers["user-agent"] = "Custom-Admin-Client/2.0";
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      res.json({ id: "token-1" });

      expect(auditLogs[0].userAgent).toBe("Custom-Admin-Client/2.0");
    });
  });

  describe("Resource Identification", () => {
    it("should record correct resource type", async () => {
      const middleware = auditLog("create_token", "token");
      const req = createMockRequest("POST", { id: "token-1" }, {
        id: "admin-123",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      res.json({ id: "token-1" });

      expect(auditLogs[0].resource).toBe("token");
    });

    it("should record resource ID from params", async () => {
      const middleware = auditLog("update_token", "token");
      const req = createMockRequest("PATCH", { id: "token-xyz-123" }, {
        id: "admin-123",
      });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      res.json({ id: "token-xyz-123" });

      expect(auditLogs[0].resourceId).toBe("token-xyz-123");
    });

    it("should record N/A for resource ID if not in params", async () => {
      const middleware = auditLog("list_tokens", "token");
      const req = createMockRequest("GET", {}, { id: "admin-123" });
      const res = createMockResponse() as any;
      const next = createMockNext();

      await middleware(req as any, res, next);

      res.json([]);

      expect(auditLogs[0].resourceId).toBe("N/A");
    });
  });
});
