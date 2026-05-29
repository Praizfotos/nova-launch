-- CreateTable
CREATE TABLE "CampaignAuditTrail" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "fromStatus" "CampaignStatus" NOT NULL,
    "toStatus" "CampaignStatus" NOT NULL,
    "actor" TEXT NOT NULL,
    "txHash" TEXT,
    "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignAuditTrail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignAuditTrail_campaignId_idx" ON "CampaignAuditTrail"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignAuditTrail_actor_idx" ON "CampaignAuditTrail"("actor");

-- CreateIndex
CREATE INDEX "CampaignAuditTrail_transitionAt_idx" ON "CampaignAuditTrail"("transitionAt");

-- AddForeignKey
ALTER TABLE "CampaignAuditTrail" ADD CONSTRAINT "CampaignAuditTrail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
