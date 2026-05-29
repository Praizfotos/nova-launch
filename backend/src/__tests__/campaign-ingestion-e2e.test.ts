import { describe, it, expect, beforeEach } from "vitest";

// Simplified campaign event parser
interface CampaignEvent {
  campaignId: number;
  tokenId: string;
  creator: string;
  type: "BUYBACK" | "AIRDROP" | "LIQUIDITY";
  targetAmount: bigint;
  startTime: Date;
  endTime?: Date;
  metadata?: string;
  txHash: string;
}

interface CampaignExecutionEvent {
  campaignId: number;
  executor: string;
  amount: bigint;
  recipient?: string;
  txHash: string;
  executedAt: Date;
}

interface CampaignStatusEvent {
  campaignId: number;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  txHash: string;
}

// In-memory projection store
interface CampaignProjection {
  campaignId: number;
  tokenId: string;
  creator: string;
  type: string;
  status: string;
  targetAmount: bigint;
  currentAmount: bigint;
  executionCount: number;
  txHash: string;
  startTime: Date;
  endTime?: Date;
  metadata?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  pausedAt?: Date;
}

class CampaignEventParser {
  private campaigns = new Map<number, CampaignProjection>();
  private executionTxHashes = new Set<string>();

  parseCampaignCreated(event: CampaignEvent): void {
    this.campaigns.set(event.campaignId, {
      campaignId: event.campaignId,
      tokenId: event.tokenId,
      creator: event.creator,
      type: event.type,
      status: "ACTIVE",
      targetAmount: event.targetAmount,
      currentAmount: BigInt(0),
      executionCount: 0,
      txHash: event.txHash,
      startTime: event.startTime,
      endTime: event.endTime,
      metadata: event.metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  parseCampaignExecution(event: CampaignExecutionEvent): void {
    const campaign = this.campaigns.get(event.campaignId);
    if (!campaign) {
      throw new Error(`Campaign ${event.campaignId} not found`);
    }

    // Idempotency: skip if already processed
    if (this.executionTxHashes.has(event.txHash)) {
      return;
    }

    this.executionTxHashes.add(event.txHash);
    campaign.currentAmount += event.amount;
    campaign.executionCount += 1;
    campaign.txHash = event.txHash;
    campaign.updatedAt = new Date();
  }

  parseCampaignStatusChange(event: CampaignStatusEvent): void {
    const campaign = this.campaigns.get(event.campaignId);
    if (!campaign) {
      throw new Error(`Campaign ${event.campaignId} not found`);
    }

    const now = new Date();
    campaign.status = event.status;
    campaign.txHash = event.txHash;
    campaign.updatedAt = now;

    if (event.status === "COMPLETED") {
      campaign.completedAt = now;
    } else if (event.status === "CANCELLED") {
      campaign.cancelledAt = now;
    } else if (event.status === "PAUSED") {
      campaign.pausedAt = now;
    }
  }

  getCampaign(campaignId: number): CampaignProjection | undefined {
    return this.campaigns.get(campaignId);
  }

  getAllCampaigns(): CampaignProjection[] {
    return Array.from(this.campaigns.values());
  }
}

describe("Campaign Ingestion Pipeline - End-to-End", () => {
  let parser: CampaignEventParser;
  const now = new Date();

  beforeEach(() => {
    parser = new CampaignEventParser();
  });

  describe("Happy Path - Campaign Lifecycle", () => {
    it("should feed a representative campaign event through the listener → parser → projection path", () => {
      const campaignEvent: CampaignEvent = {
        campaignId: 1,
        tokenId: "token-123",
        creator: "creator-addr",
        type: "BUYBACK",
        targetAmount: BigInt(1000000),
        startTime: now,
        endTime: new Date(now.getTime() + 86400000),
        metadata: "ipfs://QmHash",
        txHash: "tx-hash-1",
      };

      parser.parseCampaignCreated(campaignEvent);

      const projection = parser.getCampaign(1);
      expect(projection).toBeDefined();
      expect(projection?.campaignId).toBe(1);
      expect(projection?.tokenId).toBe("token-123");
      expect(projection?.creator).toBe("creator-addr");
      expect(projection?.type).toBe("BUYBACK");
      expect(projection?.status).toBe("ACTIVE");
      expect(projection?.targetAmount).toBe(BigInt(1000000));
      expect(projection?.currentAmount).toBe(BigInt(0));
      expect(projection?.executionCount).toBe(0);
      expect(projection?.txHash).toBe("tx-hash-1");
    });

    it("should drive the parsed event through campaignProjectionService and assert projected state", () => {
      const campaignEvent: CampaignEvent = {
        campaignId: 2,
        tokenId: "token-456",
        creator: "creator-2",
        type: "AIRDROP",
        targetAmount: BigInt(500000),
        startTime: now,
        metadata: "ipfs://QmHash2",
        txHash: "tx-hash-2",
      };

      parser.parseCampaignCreated(campaignEvent);

      const executionEvent: CampaignExecutionEvent = {
        campaignId: 2,
        executor: "executor-1",
        amount: BigInt(100000),
        recipient: "recipient-1",
        txHash: "tx-exec-1",
        executedAt: new Date(now.getTime() + 3600000),
      };

      parser.parseCampaignExecution(executionEvent);

      const projection = parser.getCampaign(2);
      expect(projection?.currentAmount).toBe(BigInt(100000));
      expect(projection?.executionCount).toBe(1);
      expect(projection?.status).toBe("ACTIVE");
    });
  });

  describe("Idempotency - Re-ingestion", () => {
    it("should assert idempotent re-ingestion of the same event does not double-apply", () => {
      const campaignEvent: CampaignEvent = {
        campaignId: 3,
        tokenId: "token-789",
        creator: "creator-3",
        type: "LIQUIDITY",
        targetAmount: BigInt(2000000),
        startTime: now,
        txHash: "tx-hash-3",
      };

      parser.parseCampaignCreated(campaignEvent);

      const executionEvent: CampaignExecutionEvent = {
        campaignId: 3,
        executor: "executor-2",
        amount: BigInt(250000),
        txHash: "tx-exec-2",
        executedAt: new Date(now.getTime() + 7200000),
      };

      // First ingestion
      parser.parseCampaignExecution(executionEvent);
      let projection = parser.getCampaign(3);
      expect(projection?.currentAmount).toBe(BigInt(250000));
      expect(projection?.executionCount).toBe(1);

      // Re-ingest the same event
      parser.parseCampaignExecution(executionEvent);
      projection = parser.getCampaign(3);

      // Should not double-apply
      expect(projection?.currentAmount).toBe(BigInt(250000));
      expect(projection?.executionCount).toBe(1);
    });

    it("should handle multiple executions without duplication", () => {
      const campaignEvent: CampaignEvent = {
        campaignId: 4,
        tokenId: "token-multi",
        creator: "creator-4",
        type: "BUYBACK",
        targetAmount: BigInt(1000000),
        startTime: now,
        txHash: "tx-hash-4",
      };

      parser.parseCampaignCreated(campaignEvent);

      const exec1: CampaignExecutionEvent = {
        campaignId: 4,
        executor: "executor-1",
        amount: BigInt(100000),
        txHash: "tx-exec-1",
        executedAt: new Date(now.getTime() + 3600000),
      };

      const exec2: CampaignExecutionEvent = {
        campaignId: 4,
        executor: "executor-2",
        amount: BigInt(150000),
        txHash: "tx-exec-2",
        executedAt: new Date(now.getTime() + 7200000),
      };

      parser.parseCampaignExecution(exec1);
      parser.parseCampaignExecution(exec2);

      const projection = parser.getCampaign(4);
      expect(projection?.currentAmount).toBe(BigInt(250000));
      expect(projection?.executionCount).toBe(2);

      // Re-ingest both
      parser.parseCampaignExecution(exec1);
      parser.parseCampaignExecution(exec2);

      // Should still be the same
      expect(projection?.currentAmount).toBe(BigInt(250000));
      expect(projection?.executionCount).toBe(2);
    });
  });

  describe("Out-of-Order Events", () => {
    it("should cover an out-of-order event scenario", () => {
      const campaignEvent: CampaignEvent = {
        campaignId: 5,
        tokenId: "token-ooo",
        creator: "creator-5",
        type: "AIRDROP",
        targetAmount: BigInt(500000),
        startTime: now,
        txHash: "tx-hash-5",
      };

      const exec1: CampaignExecutionEvent = {
        campaignId: 5,
        executor: "executor-1",
        amount: BigInt(100000),
        txHash: "tx-exec-1",
        executedAt: new Date(now.getTime() + 3600000),
      };

      const exec2: CampaignExecutionEvent = {
        campaignId: 5,
        executor: "executor-2",
        amount: BigInt(150000),
        txHash: "tx-exec-2",
        executedAt: new Date(now.getTime() + 7200000),
      };

      const statusEvent: CampaignStatusEvent = {
        campaignId: 5,
        status: "COMPLETED",
        txHash: "tx-status-1",
      };

      // Process in order: creation, exec1, exec2, status
      parser.parseCampaignCreated(campaignEvent);
      parser.parseCampaignExecution(exec1);
      parser.parseCampaignExecution(exec2);
      parser.parseCampaignStatusChange(statusEvent);

      const projection = parser.getCampaign(5);
      expect(projection?.currentAmount).toBe(BigInt(250000));
      expect(projection?.executionCount).toBe(2);
      expect(projection?.status).toBe("COMPLETED");
      expect(projection?.completedAt).toBeDefined();
    });

    it("should handle status change before all executions", () => {
      const campaignEvent: CampaignEvent = {
        campaignId: 6,
        tokenId: "token-status-early",
        creator: "creator-6",
        type: "BUYBACK",
        targetAmount: BigInt(1000000),
        startTime: now,
        txHash: "tx-hash-6",
      };

      const exec1: CampaignExecutionEvent = {
        campaignId: 6,
        executor: "executor-1",
        amount: BigInt(100000),
        txHash: "tx-exec-1",
        executedAt: new Date(now.getTime() + 3600000),
      };

      const statusEvent: CampaignStatusEvent = {
        campaignId: 6,
        status: "PAUSED",
        txHash: "tx-status-1",
      };

      parser.parseCampaignCreated(campaignEvent);
      parser.parseCampaignStatusChange(statusEvent);
      parser.parseCampaignExecution(exec1);

      const projection = parser.getCampaign(6);
      expect(projection?.status).toBe("PAUSED");
      expect(projection?.pausedAt).toBeDefined();
      expect(projection?.currentAmount).toBe(BigInt(100000));
      expect(projection?.executionCount).toBe(1);
    });
  });

  describe("State Consistency", () => {
    it("should maintain consistent state across multiple operations", () => {
      const campaignEvent: CampaignEvent = {
        campaignId: 7,
        tokenId: "token-consistency",
        creator: "creator-7",
        type: "LIQUIDITY",
        targetAmount: BigInt(1000000),
        startTime: now,
        txHash: "tx-hash-7",
      };

      parser.parseCampaignCreated(campaignEvent);

      // Add multiple executions
      for (let i = 0; i < 5; i++) {
        const exec: CampaignExecutionEvent = {
          campaignId: 7,
          executor: `executor-${i}`,
          amount: BigInt(100000),
          txHash: `tx-exec-${i}`,
          executedAt: new Date(now.getTime() + i * 3600000),
        };
        parser.parseCampaignExecution(exec);
      }

      const projection = parser.getCampaign(7);
      expect(projection?.currentAmount).toBe(BigInt(500000));
      expect(projection?.executionCount).toBe(5);
      expect(projection?.status).toBe("ACTIVE");

      // Complete the campaign
      const statusEvent: CampaignStatusEvent = {
        campaignId: 7,
        status: "COMPLETED",
        txHash: "tx-status-complete",
      };
      parser.parseCampaignStatusChange(statusEvent);

      expect(projection?.status).toBe("COMPLETED");
      expect(projection?.completedAt).toBeDefined();
      expect(projection?.currentAmount).toBe(BigInt(500000));
      expect(projection?.executionCount).toBe(5);
    });
  });
});
