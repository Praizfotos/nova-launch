import { describe, it, expect } from "vitest";
import {
  CreateCampaignSchema,
  CampaignIdParamSchema,
  CampaignCreatorParamSchema,
  CampaignExecutionQuerySchema,
} from "../lib/validation/campaignSchemas";

const VALID_CREATOR = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGPCQHQ9PRURP4DGJDRNL";

const validBody = {
  tokenId: "tok-abc",
  creator: VALID_CREATOR,
  type: "BUYBACK" as const,
  targetAmount: "1000000",
  startTime: "2025-01-01T00:00:00Z",
};

describe("CreateCampaignSchema", () => {
  it("accepts a valid body", () => {
    expect(CreateCampaignSchema.safeParse(validBody).success).toBe(true);
  });

  it("rejects a missing tokenId", () => {
    const { tokenId: _, ...rest } = validBody;
    const r = CreateCampaignSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it("rejects an invalid Stellar creator address", () => {
    const r = CreateCampaignSchema.safeParse({ ...validBody, creator: "not-stellar" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain("Stellar address");
  });

  it("rejects an invalid campaign type", () => {
    const r = CreateCampaignSchema.safeParse({ ...validBody, type: "INVALID" });
    expect(r.success).toBe(false);
  });

  it("rejects a zero targetAmount", () => {
    const r = CreateCampaignSchema.safeParse({ ...validBody, targetAmount: "0" });
    expect(r.success).toBe(false);
  });

  it("rejects a non-integer targetAmount", () => {
    const r = CreateCampaignSchema.safeParse({ ...validBody, targetAmount: "12.5" });
    expect(r.success).toBe(false);
  });

  it("rejects endTime before startTime", () => {
    const r = CreateCampaignSchema.safeParse({
      ...validBody,
      endTime: "2024-01-01T00:00:00Z",
    });
    expect(r.success).toBe(false);
    const err = r as any;
    expect(err.error.errors.some((e: any) => e.path.includes("endTime"))).toBe(true);
  });

  it("accepts optional endTime after startTime", () => {
    const r = CreateCampaignSchema.safeParse({
      ...validBody,
      endTime: "2025-06-01T00:00:00Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects metadata exceeding 1024 characters", () => {
    const r = CreateCampaignSchema.safeParse({ ...validBody, metadata: "a".repeat(1025) });
    expect(r.success).toBe(false);
  });

  it("strips unknown fields", () => {
    const r = CreateCampaignSchema.safeParse({ ...validBody, injectedField: "bad" });
    expect(r.success).toBe(false); // .strict() rejects unknown keys
  });
});

describe("CampaignIdParamSchema", () => {
  it("accepts a positive integer string", () => {
    expect(CampaignIdParamSchema.safeParse({ campaignId: "42" }).success).toBe(true);
  });

  it("rejects zero", () => {
    expect(CampaignIdParamSchema.safeParse({ campaignId: "0" }).success).toBe(false);
  });

  it("rejects non-numeric", () => {
    expect(CampaignIdParamSchema.safeParse({ campaignId: "abc" }).success).toBe(false);
  });
});

describe("CampaignCreatorParamSchema", () => {
  it("accepts a valid G-address", () => {
    expect(CampaignCreatorParamSchema.safeParse({ creator: VALID_CREATOR }).success).toBe(true);
  });

  it("rejects an invalid address", () => {
    expect(CampaignCreatorParamSchema.safeParse({ creator: "badaddr" }).success).toBe(false);
  });
});

describe("CampaignExecutionQuerySchema", () => {
  it("accepts valid limit and offset", () => {
    expect(
      CampaignExecutionQuerySchema.safeParse({ limit: "50", offset: "0" }).success,
    ).toBe(true);
  });

  it("rejects limit > 200", () => {
    expect(CampaignExecutionQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
  });

  it("rejects negative offset", () => {
    expect(CampaignExecutionQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
  });

  it("accepts empty query params (all optional)", () => {
    expect(CampaignExecutionQuerySchema.safeParse({}).success).toBe(true);
  });
});
