import { z } from "zod";
import { Request, Response, NextFunction } from "express";

const CAMPAIGN_TYPES = ["BUYBACK", "AIRDROP", "LIQUIDITY"] as const;

const stellarAddressRegex = /^G[A-Z2-7]{55}$/;

const StellarAddress = z
  .string()
  .trim()
  .regex(stellarAddressRegex, "must be a valid Stellar address (G…)");

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

export const CreateCampaignSchema = z
  .object({
    tokenId: z.string().trim().min(1, "tokenId is required"),
    creator: StellarAddress,
    type: z.enum(CAMPAIGN_TYPES, {
      errorMap: () => ({ message: `type must be one of: ${CAMPAIGN_TYPES.join(", ")}` }),
    }),
    targetAmount: z
      .string()
      .trim()
      .regex(/^\d+$/, "targetAmount must be a non-negative integer string")
      .refine((v) => BigInt(v) > 0n, { message: "targetAmount must be greater than zero" }),
    startTime: z.string().datetime({ message: "startTime must be a valid ISO 8601 date" }),
    endTime: z
      .string()
      .datetime({ message: "endTime must be a valid ISO 8601 date" })
      .optional(),
    metadata: z
      .string()
      .max(1024, "metadata must not exceed 1024 characters")
      .optional(),
    txHash: z.string().optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.endTime && data.startTime) {
        return new Date(data.endTime) > new Date(data.startTime);
      }
      return true;
    },
    { message: "endTime must be after startTime", path: ["endTime"] },
  );

export const CampaignIdParamSchema = z.object({
  campaignId: z
    .string()
    .regex(/^\d+$/, "campaignId must be a positive integer")
    .refine((v) => parseInt(v) >= 1, { message: "campaignId must be a positive integer" }),
});

export const CampaignTokenParamSchema = z.object({
  tokenId: z.string().trim().min(1, "tokenId is required"),
});

export const CampaignCreatorParamSchema = z.object({
  creator: StellarAddress,
});

export const CampaignExecutionQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/)
    .refine((v) => parseInt(v) >= 1 && parseInt(v) <= 200, {
      message: "limit must be between 1 and 200",
    })
    .optional(),
  offset: z
    .string()
    .regex(/^\d+$/, "offset must be a non-negative integer")
    .optional(),
});

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

type ZodSchema = z.ZodTypeAny;

function zodValidate(
  schema: ZodSchema,
  source: "body" | "params" | "query",
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: result.error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      });
    }
    // Replace the source with the parsed (stripped + coerced) data
    (req as any)[source] = result.data;
    next();
  };
}

export const validateCreateCampaignBody = zodValidate(CreateCampaignSchema, "body");
export const validateCampaignIdParam = zodValidate(CampaignIdParamSchema, "params");
export const validateCampaignTokenParam = zodValidate(CampaignTokenParamSchema, "params");
export const validateCampaignCreatorParam = zodValidate(CampaignCreatorParamSchema, "params");
export const validateCampaignExecutionQuery = zodValidate(CampaignExecutionQuerySchema, "query");
