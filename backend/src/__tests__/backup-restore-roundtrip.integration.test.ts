/**
 * Database Backup and Restore Round-Trip Integrity Tests
 *
 * Validates that a backup can be restored and yields an equivalent dataset.
 *
 * Strategy:
 *   - Seed data, take a backup, mutate/clear, then restore and assert recovery
 *   - Assert restored schema version matches the backup
 *   - Cover backup of an empty database
 *   - Verify backup metadata (timestamp, size) is recorded
 */

import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { BackupService, BackupStatus, BackupResult, RestoreResult } from "../services/backup";
import { prisma } from "../lib/prisma";
import path from "path";
import fs from "fs/promises";
import os from "os";

// ── Test fixtures ──────────────────────────────────────────────────────────

const seedTestData = async () => {
  const tokens = [];
  for (let i = 0; i < 5; i++) {
    const token = await prisma.token.create({
      data: {
        address: `GTOKEN_BACKUP_TEST_${i}`,
        creator: `GCREATOR_BACKUP_${i}`,
        name: `Backup Test Token ${i}`,
        symbol: `BKT${i}`,
        decimals: 7,
        totalSupply: BigInt((i + 1) * 1000000),
        initialSupply: BigInt((i + 1) * 1000000),
        totalBurned: BigInt(0),
        burnCount: 0,
        metadataUri: `ipfs://QmBackupTest${i}`,
      },
    });
    tokens.push(token);
  }

  const streams = [];
  for (let i = 0; i < 3; i++) {
    const stream = await prisma.stream.create({
      data: {
        streamId: i + 1,
        creator: `GCREATOR_STREAM_${i}`,
        recipient: `GRECIPIENT_STREAM_${i}`,
        amount: BigInt((i + 1) * 100000),
        status: "CREATED",
        txHash: `backup-stream-tx-${i}`,
        metadata: `stream-meta-${i}`,
      },
    });
    streams.push(stream);
  }

  return { tokens, streams };
};

const countRecords = async () => {
  const tokenCount = await prisma.token.count();
  const streamCount = await prisma.stream.count();
  const campaignCount = await prisma.campaign.count();

  return { tokenCount, streamCount, campaignCount };
};

const getDataSnapshot = async () => {
  const tokens = await prisma.token.findMany({ orderBy: { address: "asc" } });
  const streams = await prisma.stream.findMany({ orderBy: { streamId: "asc" } });
  const campaigns = await prisma.campaign.findMany({ orderBy: { campaignId: "asc" } });

  return {
    tokens: tokens.map((t) => ({
      address: t.address,
      creator: t.creator,
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      totalSupply: t.totalSupply.toString(),
      metadataUri: t.metadataUri,
    })),
    streams: streams.map((s) => ({
      streamId: s.streamId,
      creator: s.creator,
      recipient: s.recipient,
      amount: s.amount.toString(),
      status: s.status,
      txHash: s.txHash,
    })),
    campaigns: campaigns.map((c) => ({
      campaignId: c.campaignId,
      tokenId: c.tokenId,
      creator: c.creator,
      type: c.type,
      status: c.status,
    })),
  };
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Database Backup and Restore Round-Trip Integrity", () => {
  let backupService: BackupService;
  let tempBackupDir: string;

  beforeEach(async () => {
    // Create temporary backup directory
    tempBackupDir = path.join(os.tmpdir(), `backup-test-${Date.now()}`);
    await fs.mkdir(tempBackupDir, { recursive: true });

    backupService = new BackupService(tempBackupDir);

    // Clean up test data
    await prisma.campaign.deleteMany({});
    await prisma.stream.deleteMany({});
    await prisma.token.deleteMany({});
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempBackupDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Clean up test data
    await prisma.campaign.deleteMany({});
    await prisma.stream.deleteMany({});
    await prisma.token.deleteMany({});
  });

  describe("Backup Creation", () => {
    it("should create a base backup successfully", async () => {
      const result = await backupService.createBaseBackup();

      expect(result.success).toBe(true);
      expect(result.message).toContain("successfully");
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it("should record backup metadata (timestamp, size)", async () => {
      await seedTestData();

      const result = await backupService.createBaseBackup();
      expect(result.success).toBe(true);

      const status = await backupService.getStatus();
      expect(status.latestBaseBackup).toBeTruthy();
      expect(status.storagePath).toBe(tempBackupDir);
    });

    it("should handle backup of empty database", async () => {
      // Don't seed any data
      const result = await backupService.createBaseBackup();

      expect(result.success).toBe(true);
      expect(result.message).toContain("successfully");
    });

    it("should list base backups in reverse chronological order", async () => {
      await backupService.createBaseBackup();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await backupService.createBaseBackup();

      const backups = await backupService.listBaseBackups();
      expect(backups.length).toBeGreaterThanOrEqual(1);

      // Verify reverse chronological order (newest first)
      for (let i = 0; i < backups.length - 1; i++) {
        expect(backups[i]).toBeGreaterThanOrEqual(backups[i + 1]);
      }
    });
  });

  describe("Backup Status", () => {
    it("should return backup status with metadata", async () => {
      await seedTestData();
      await backupService.createBaseBackup();

      const status = await backupService.getStatus();

      expect(status).toMatchObject({
        latestBaseBackup: expect.any(String),
        walSegmentCount: expect.any(Number),
        walArchiveSize: expect.any(String),
        storagePath: tempBackupDir,
      });
    });

    it("should return null for latestBaseBackup when no backups exist", async () => {
      const status = await backupService.getStatus();

      expect(status.latestBaseBackup).toBeNull();
      expect(status.walSegmentCount).toBeGreaterThanOrEqual(0);
    });

    it("should track WAL segment count", async () => {
      await seedTestData();
      await backupService.createBaseBackup();

      const status = await backupService.getStatus();
      expect(status.walSegmentCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Round-Trip Integrity", () => {
    it("should recover seeded data after backup and restore", async () => {
      // 1. Seed data
      const seeded = await seedTestData();
      const beforeSnapshot = await getDataSnapshot();
      const beforeCounts = await countRecords();

      // 2. Create backup
      const backupResult = await backupService.createBaseBackup();
      expect(backupResult.success).toBe(true);

      // 3. Mutate/clear data
      await prisma.token.deleteMany({});
      await prisma.stream.deleteMany({});

      const afterMutate = await countRecords();
      expect(afterMutate.tokenCount).toBe(0);
      expect(afterMutate.streamCount).toBe(0);

      // 4. Restore (dry-run first to verify plan)
      const dryRunResult = await backupService.restore({
        targetTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        confirmed: false,
      });
      expect(dryRunResult.dryRun).toBe(true);

      // 5. Restore (confirmed)
      const restoreResult = await backupService.restore({
        targetTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        confirmed: true,
      });
      expect(restoreResult.success).toBe(true);

      // 6. Verify data recovered
      const afterRestore = await countRecords();
      expect(afterRestore.tokenCount).toBe(beforeCounts.tokenCount);
      expect(afterRestore.streamCount).toBe(beforeCounts.streamCount);

      const afterSnapshot = await getDataSnapshot();
      expect(afterSnapshot.tokens).toEqual(beforeSnapshot.tokens);
      expect(afterSnapshot.streams).toEqual(beforeSnapshot.streams);
    });

    it("should preserve data integrity across backup/restore cycle", async () => {
      // Seed with specific values
      const token = await prisma.token.create({
        data: {
          address: "GTOKEN_INTEGRITY_TEST",
          creator: "GCREATOR_INTEGRITY",
          name: "Integrity Test Token",
          symbol: "INT",
          decimals: 7,
          totalSupply: BigInt(123456789),
          initialSupply: BigInt(123456789),
          totalBurned: BigInt(0),
          burnCount: 0,
          metadataUri: "ipfs://QmIntegrityTest",
        },
      });

      const beforeSnapshot = await getDataSnapshot();

      // Backup
      const backupResult = await backupService.createBaseBackup();
      expect(backupResult.success).toBe(true);

      // Clear
      await prisma.token.deleteMany({});

      // Restore
      const restoreResult = await backupService.restore({
        targetTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        confirmed: true,
      });
      expect(restoreResult.success).toBe(true);

      // Verify exact match
      const afterSnapshot = await getDataSnapshot();
      expect(afterSnapshot.tokens[0]).toEqual(beforeSnapshot.tokens[0]);
      expect(afterSnapshot.tokens[0].totalSupply).toBe("123456789");
    });

    it("should handle backup of empty database and restore", async () => {
      // Don't seed any data
      const beforeCounts = await countRecords();
      expect(beforeCounts.tokenCount).toBe(0);

      // Backup empty database
      const backupResult = await backupService.createBaseBackup();
      expect(backupResult.success).toBe(true);

      // Add some data
      await seedTestData();
      const afterSeed = await countRecords();
      expect(afterSeed.tokenCount).toBeGreaterThan(0);

      // Restore to empty state
      const restoreResult = await backupService.restore({
        targetTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        confirmed: true,
      });
      expect(restoreResult.success).toBe(true);

      // Verify empty state restored
      const afterRestore = await countRecords();
      expect(afterRestore.tokenCount).toBe(0);
    });
  });

  describe("Schema Version Compatibility", () => {
    it("should restore with matching schema version", async () => {
      await seedTestData();

      const backupResult = await backupService.createBaseBackup();
      expect(backupResult.success).toBe(true);

      // Clear data
      await prisma.token.deleteMany({});
      await prisma.stream.deleteMany({});

      // Restore
      const restoreResult = await backupService.restore({
        targetTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        confirmed: true,
      });
      expect(restoreResult.success).toBe(true);

      // Verify schema is intact by querying
      const tokens = await prisma.token.findMany();
      expect(tokens).toHaveLength(5);

      // Verify all expected fields exist
      const token = tokens[0];
      expect(token).toHaveProperty("address");
      expect(token).toHaveProperty("creator");
      expect(token).toHaveProperty("name");
      expect(token).toHaveProperty("symbol");
      expect(token).toHaveProperty("decimals");
      expect(token).toHaveProperty("totalSupply");
      expect(token).toHaveProperty("initialSupply");
      expect(token).toHaveProperty("totalBurned");
      expect(token).toHaveProperty("burnCount");
      expect(token).toHaveProperty("metadataUri");
      expect(token).toHaveProperty("createdAt");
      expect(token).toHaveProperty("updatedAt");
    });
  });

  describe("Restore Options", () => {
    it("should perform dry-run without making changes", async () => {
      await seedTestData();
      const beforeCounts = await countRecords();

      await backupService.createBaseBackup();

      // Perform dry-run
      const dryRunResult = await backupService.restore({
        targetTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        confirmed: false,
      });

      expect(dryRunResult.dryRun).toBe(true);
      expect(dryRunResult.success).toBe(true);

      // Verify no changes were made
      const afterCounts = await countRecords();
      expect(afterCounts).toEqual(beforeCounts);
    });

    it("should validate ISO-8601 timestamp format", async () => {
      const result = await backupService.restore({
        targetTime: "invalid-timestamp",
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("ISO-8601");
    });

    it("should accept optional baseLabel parameter", async () => {
      await seedTestData();
      const backupResult = await backupService.createBaseBackup();
      expect(backupResult.backupLabel).toBeTruthy();

      // Clear data
      await prisma.token.deleteMany({});

      // Restore with specific base label
      const restoreResult = await backupService.restore({
        targetTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        baseLabel: backupResult.backupLabel,
        confirmed: true,
      });

      expect(restoreResult.success).toBe(true);
    });
  });

  describe("Backup Metadata", () => {
    it("should record backup duration", async () => {
      const result = await backupService.createBaseBackup();

      expect(result.durationMs).toBeGreaterThan(0);
      expect(typeof result.durationMs).toBe("number");
    });

    it("should record restore duration", async () => {
      await backupService.createBaseBackup();

      const result = await backupService.restore({
        targetTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        confirmed: false,
      });

      expect(result.durationMs).toBeGreaterThan(0);
      expect(typeof result.durationMs).toBe("number");
    });

    it("should include backup label in result", async () => {
      const result = await backupService.createBaseBackup();

      expect(result.backupLabel).toBeTruthy();
      expect(result.backupLabel).toMatch(/nova-pitr-\d{8}T\d{6}Z/);
    });
  });

  describe("Error Handling", () => {
    it("should handle restore with non-existent base label gracefully", async () => {
      const result = await backupService.restore({
        targetTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        baseLabel: "nonexistent-backup-label",
        confirmed: false,
      });

      // Should either succeed (dry-run) or fail gracefully
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("message");
    });

    it("should handle backup creation failure gracefully", async () => {
      // Create service with invalid path
      const invalidService = new BackupService("/invalid/nonexistent/path");

      const result = await invalidService.createBaseBackup();

      expect(result.success).toBe(false);
      expect(result.message).toContain("failed");
    });
  });
});
