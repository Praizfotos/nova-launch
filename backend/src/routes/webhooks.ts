import { Router, Request, Response } from "express";
import webhookService from "../services/webhookService";
import webhookDeliveryService from "../services/webhookDeliveryService";
import webhookDeadLetterService from "../services/webhookDeadLetterService";
import {
  validateSubscriptionCreate,
  validateSubscriptionId,
  validateListSubscriptions,
} from "../middleware/validation";
import { webhookRateLimiter, webhookUserRateLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * POST /api/webhooks/subscribe
 * Create a new webhook subscription
 */
router.post(
  "/subscribe",
  webhookUserRateLimiter,
  webhookRateLimiter,
  validateSubscriptionCreate,
  async (req: Request, res: Response) => {
    try {
      const subscription = await webhookService.createSubscription(req.body);

      // Return subscription with full secret ONLY on creation
      // Users must store this secret securely as it won't be shown again
      res.status(201).json({
        success: true,
        data: subscription,
        message: "Webhook subscription created successfully. Please store your secret securely; it will not be shown again.",
      });
    } catch (error) {
      console.error("Error creating subscription:", error);
      res.status(500).json({
        success: false,
        error: "Failed to create webhook subscription",
      });
    }
  }
);

/**
 * DELETE /api/webhooks/unsubscribe/:id
 * Delete a webhook subscription
 */
router.delete(
  "/unsubscribe/:id",
  webhookUserRateLimiter,
  webhookRateLimiter,
  validateSubscriptionId,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { createdBy } = req.body;

      if (!createdBy) {
        return res.status(400).json({
          success: false,
          error: "createdBy address is required",
        });
      }

      const deleted = await webhookService.deleteSubscription(id, createdBy);

      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: "Subscription not found or unauthorized",
        });
      }

      res.json({
        success: true,
        message: "Webhook subscription deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting subscription:", error);
      res.status(500).json({
        success: false,
        error: "Failed to delete webhook subscription",
      });
    }
  }
);

/**
 * POST /api/webhooks/list
 * List webhook subscriptions for a user
 */
router.post(
  "/list",
  validateListSubscriptions,
  async (req: Request, res: Response) => {
    try {
      const { createdBy, active } = req.body;

      const subscriptions = await webhookService.listSubscriptions(
        createdBy,
        active
      );

      // Hide secrets in response
      const publicSubscriptions = subscriptions.map((sub) => {
        const { secret, ...publicData } = sub;
        return {
          ...publicData,
          secret: `${secret.substring(0, 8)}...`,
        };
      });

      res.json({
        success: true,
        data: publicSubscriptions,
        count: publicSubscriptions.length,
      });
    } catch (error) {
      console.error("Error listing subscriptions:", error);
      res.status(500).json({
        success: false,
        error: "Failed to list webhook subscriptions",
      });
    }
  }
);

/**
 * GET /api/webhooks/:id
 * Get a specific webhook subscription
 */
router.get(
  "/:id",
  validateSubscriptionId,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const subscription = await webhookService.getSubscription(id);

      if (!subscription) {
        return res.status(404).json({
          success: false,
          error: "Subscription not found",
        });
      }

      // Hide secret
      const { secret, ...publicData } = subscription;

      res.json({
        success: true,
        data: {
          ...publicData,
          secret: `${secret.substring(0, 8)}...`,
        },
      });
    } catch (error) {
      console.error("Error fetching subscription:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch webhook subscription",
      });
    }
  }
);

/**
 * PATCH /api/webhooks/:id/toggle
 * Toggle webhook subscription active status
 */
router.patch(
  "/:id/toggle",
  webhookUserRateLimiter,
  webhookRateLimiter,
  validateSubscriptionId,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { active } = req.body;

      if (typeof active !== "boolean") {
        return res.status(400).json({
          success: false,
          error: "active field must be a boolean",
        });
      }

      const updated = await webhookService.updateSubscriptionStatus(id, active);

      if (!updated) {
        return res.status(404).json({
          success: false,
          error: "Subscription not found",
        });
      }

      res.json({
        success: true,
        message: `Subscription ${active ? "activated" : "deactivated"} successfully`,
      });
    } catch (error) {
      console.error("Error toggling subscription:", error);
      res.status(500).json({
        success: false,
        error: "Failed to toggle webhook subscription",
      });
    }
  }
);

/**
 * GET /api/webhooks/:id/logs
 * Get delivery logs for a subscription
 */
router.get(
  "/:id/logs",
  validateSubscriptionId,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const limit = parseInt(req.query.limit as string) || 50;

      const logs = await webhookService.getDeliveryLogs(id, limit);

      res.json({
        success: true,
        data: logs,
        count: logs.length,
      });
    } catch (error) {
      console.error("Error fetching delivery logs:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch delivery logs",
      });
    }
  }
);

/**
 * POST /api/webhooks/:id/test
 * Test a webhook subscription
 */
router.post(
  "/:id/test",
  webhookRateLimiter,
  validateSubscriptionId,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const subscription = await webhookService.getSubscription(id);

      if (!subscription) {
        return res.status(404).json({
          success: false,
          error: "Subscription not found",
        });
      }

      const success = await webhookDeliveryService.testWebhook(subscription);

      res.json({
        success,
        message: success
          ? "Test webhook delivered successfully"
          : "Test webhook delivery failed",
      });
    } catch (error) {
      console.error("Error testing webhook:", error);
      res.status(500).json({
        success: false,
        error: "Failed to test webhook",
      });
    }
  }
);

/**
 * GET /api/webhooks/:id/dead-letters
 * List dead-lettered deliveries for a subscription
 */
router.get(
  "/:id/dead-letters",
  validateSubscriptionId,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const limit = parseInt(req.query.limit as string) || 50;

      const subscription = await webhookService.getSubscription(id);
      if (!subscription) {
        return res.status(404).json({
          success: false,
          error: "Subscription not found",
        });
      }

      const deadLetters = await webhookDeadLetterService.listUnresolved(id, limit);

      res.json({
        success: true,
        data: deadLetters,
        count: deadLetters.length,
      });
    } catch (error) {
      console.error("Error fetching dead letters:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch dead-letter deliveries",
      });
    }
  }
);

/**
 * POST /api/webhooks/dead-letters/:id/retry
 * Retry a dead-lettered delivery
 */
router.post(
  "/dead-letters/:id/retry",
  webhookRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deadLetter = await webhookDeadLetterService.getEntry(id);

      if (!deadLetter) {
        return res.status(404).json({
          success: false,
          error: "Dead-letter entry not found",
        });
      }

      const subscription = await webhookService.getSubscription(deadLetter.subscriptionId);
      if (!subscription) {
        return res.status(404).json({
          success: false,
          error: "Associated subscription not found",
        });
      }

      // Re-deliver the webhook
      const payload = JSON.parse(deadLetter.payload);
      await webhookDeliveryService.deliverWebhook(
        subscription,
        deadLetter.event,
        payload.data || payload,
        `retry_${id}`
      );

      // Mark as resolved
      await webhookDeadLetterService.markResolved(id, "retried");

      res.json({
        success: true,
        message: "Dead-letter delivery retried successfully",
      });
    } catch (error) {
      console.error("Error retrying dead letter:", error);
      res.status(500).json({
        success: false,
        error: "Failed to retry dead-letter delivery",
      });
    }
  }
);

/**
 * POST /api/webhooks/dead-letters/:id/skip
 * Skip/archive a dead-lettered delivery
 */
router.post(
  "/dead-letters/:id/skip",
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deadLetter = await webhookDeadLetterService.getEntry(id);

      if (!deadLetter) {
        return res.status(404).json({
          success: false,
          error: "Dead-letter entry not found",
        });
      }

      await webhookDeadLetterService.markResolved(id, "skipped");

      res.json({
        success: true,
        message: "Dead-letter delivery archived",
      });
    } catch (error) {
      console.error("Error skipping dead letter:", error);
      res.status(500).json({
        success: false,
        error: "Failed to archive dead-letter delivery",
      });
    }
  }
);

export default router;
