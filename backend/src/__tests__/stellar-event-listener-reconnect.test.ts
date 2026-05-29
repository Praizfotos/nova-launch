import { describe, it, expect, beforeEach, vi } from "vitest";

// Event cursor store
interface CursorState {
  cursor: number;
  lastProcessedLedger: number;
  lastProcessedAt: Date;
}

class EventCursorStore {
  private cursorState: CursorState = {
    cursor: 0,
    lastProcessedLedger: 0,
    lastProcessedAt: new Date(),
  };

  getCursor(): number {
    return this.cursorState.cursor;
  }

  updateCursor(cursor: number, ledger: number): void {
    this.cursorState.cursor = cursor;
    this.cursorState.lastProcessedLedger = ledger;
    this.cursorState.lastProcessedAt = new Date();
  }

  getState(): CursorState {
    return { ...this.cursorState };
  }
}

// Simulated Stellar event
interface StellarEvent {
  id: string;
  ledger: number;
  type: string;
  data: Record<string, unknown>;
}

// Event listener with reconnection logic
class StellarEventListener {
  private cursorStore: EventCursorStore;
  private isConnected = false;
  private processedEvents = new Set<string>();
  private eventBuffer: StellarEvent[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;

  constructor(cursorStore: EventCursorStore) {
    this.cursorStore = cursorStore;
  }

  async connect(): Promise<void> {
    this.isConnected = true;
    this.reconnectAttempts = 0;
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  async simulateStreamDisconnect(): Promise<void> {
    this.isConnected = false;
  }

  async reconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      throw new Error("Max reconnection attempts exceeded");
    }

    this.reconnectAttempts++;
    // Simulate reconnection delay
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.isConnected = true;
  }

  async ingestEvents(events: StellarEvent[]): Promise<void> {
    if (!this.isConnected) {
      throw new Error("Not connected");
    }

    for (const event of events) {
      // Skip if already processed (idempotency)
      if (this.processedEvents.has(event.id)) {
        continue;
      }

      this.processedEvents.add(event.id);
      this.eventBuffer.push(event);

      // Update cursor after each event
      this.cursorStore.updateCursor(parseInt(event.id), event.ledger);
    }
  }

  async resumeFromCursor(): Promise<StellarEvent[]> {
    const cursor = this.cursorStore.getCursor();
    // Return events after the cursor
    return this.eventBuffer.filter((e) => parseInt(e.id) > cursor);
  }

  getProcessedEventCount(): number {
    return this.processedEvents.size;
  }

  getEventBuffer(): StellarEvent[] {
    return [...this.eventBuffer];
  }

  isConnectedStatus(): boolean {
    return this.isConnected;
  }
}

describe("Stellar Event Listener - Reconnection and Cursor Resume", () => {
  let listener: StellarEventListener;
  let cursorStore: EventCursorStore;

  beforeEach(() => {
    cursorStore = new EventCursorStore();
    listener = new StellarEventListener(cursorStore);
  });

  describe("Happy Path - Normal Operation", () => {
    it("should ingest events and update cursor", async () => {
      await listener.connect();

      const events: StellarEvent[] = [
        {
          id: "1",
          ledger: 100,
          type: "payment",
          data: { amount: 100 },
        },
        {
          id: "2",
          ledger: 101,
          type: "payment",
          data: { amount: 200 },
        },
      ];

      await listener.ingestEvents(events);

      const state = cursorStore.getState();
      expect(state.cursor).toBe(2);
      expect(state.lastProcessedLedger).toBe(101);
    });
  });

  describe("Reconnection - Stream Disconnect", () => {
    it("should simulate a stream disconnect mid-ingestion and assert reconnection occurs", async () => {
      await listener.connect();
      expect(listener.isConnectedStatus()).toBe(true);

      const events1: StellarEvent[] = [
        { id: "1", ledger: 100, type: "payment", data: { amount: 100 } },
        { id: "2", ledger: 101, type: "payment", data: { amount: 200 } },
      ];

      await listener.ingestEvents(events1);
      expect(listener.getProcessedEventCount()).toBe(2);

      // Simulate disconnect
      await listener.simulateStreamDisconnect();
      expect(listener.isConnectedStatus()).toBe(false);

      // Attempt to ingest should fail
      const events2: StellarEvent[] = [
        { id: "3", ledger: 102, type: "payment", data: { amount: 300 } },
      ];

      await expect(listener.ingestEvents(events2)).rejects.toThrow(
        "Not connected"
      );

      // Reconnect
      await listener.reconnect();
      expect(listener.isConnectedStatus()).toBe(true);

      // Should be able to ingest again
      await listener.ingestEvents(events2);
      expect(listener.getProcessedEventCount()).toBe(3);
    });
  });

  describe("Cursor Resume - No Gaps", () => {
    it("should assert ingestion resumes from the persisted cursor (no gaps)", async () => {
      await listener.connect();

      const events1: StellarEvent[] = [
        { id: "1", ledger: 100, type: "payment", data: { amount: 100 } },
        { id: "2", ledger: 101, type: "payment", data: { amount: 200 } },
        { id: "3", ledger: 102, type: "payment", data: { amount: 300 } },
      ];

      await listener.ingestEvents(events1);
      const cursorAfterFirstBatch = cursorStore.getCursor();
      expect(cursorAfterFirstBatch).toBe(3);

      // Simulate disconnect and reconnect
      await listener.simulateStreamDisconnect();
      await listener.reconnect();

      // Resume from cursor
      const resumedEvents = await listener.resumeFromCursor();
      expect(resumedEvents).toHaveLength(0); // No events after cursor 3

      // Ingest new events
      const events2: StellarEvent[] = [
        { id: "4", ledger: 103, type: "payment", data: { amount: 400 } },
        { id: "5", ledger: 104, type: "payment", data: { amount: 500 } },
      ];

      await listener.ingestEvents(events2);
      const cursorAfterSecondBatch = cursorStore.getCursor();
      expect(cursorAfterSecondBatch).toBe(5);

      // Verify no gaps
      const allEvents = listener.getEventBuffer();
      expect(allEvents).toHaveLength(5);
      expect(allEvents.map((e) => parseInt(e.id))).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("Idempotency - No Duplicate Processing", () => {
    it("should assert no events are processed twice across the reconnect", async () => {
      await listener.connect();

      const events1: StellarEvent[] = [
        { id: "1", ledger: 100, type: "payment", data: { amount: 100 } },
        { id: "2", ledger: 101, type: "payment", data: { amount: 200 } },
      ];

      await listener.ingestEvents(events1);
      expect(listener.getProcessedEventCount()).toBe(2);

      // Simulate disconnect and reconnect
      await listener.simulateStreamDisconnect();
      await listener.reconnect();

      // Try to re-ingest the same events
      await listener.ingestEvents(events1);

      // Should still be 2 (not 4)
      expect(listener.getProcessedEventCount()).toBe(2);

      // Ingest new events
      const events2: StellarEvent[] = [
        { id: "3", ledger: 102, type: "payment", data: { amount: 300 } },
      ];

      await listener.ingestEvents(events2);
      expect(listener.getProcessedEventCount()).toBe(3);
    });

    it("should handle duplicate events in the same batch", async () => {
      await listener.connect();

      const events: StellarEvent[] = [
        { id: "1", ledger: 100, type: "payment", data: { amount: 100 } },
        { id: "1", ledger: 100, type: "payment", data: { amount: 100 } }, // Duplicate
        { id: "2", ledger: 101, type: "payment", data: { amount: 200 } },
      ];

      await listener.ingestEvents(events);

      // Should only process 2 unique events
      expect(listener.getProcessedEventCount()).toBe(2);
    });
  });

  describe("Latest Ledger - Cursor at Latest", () => {
    it("should cover the case where the cursor is at the latest ledger", async () => {
      await listener.connect();

      const events: StellarEvent[] = [
        { id: "1", ledger: 100, type: "payment", data: { amount: 100 } },
        { id: "2", ledger: 101, type: "payment", data: { amount: 200 } },
        { id: "3", ledger: 102, type: "payment", data: { amount: 300 } },
      ];

      await listener.ingestEvents(events);
      const state = cursorStore.getState();
      expect(state.lastProcessedLedger).toBe(102);

      // Simulate disconnect and reconnect
      await listener.simulateStreamDisconnect();
      await listener.reconnect();

      // Resume from cursor - should have no new events
      const resumedEvents = await listener.resumeFromCursor();
      expect(resumedEvents).toHaveLength(0);

      // Ingest new events at higher ledger
      const newEvents: StellarEvent[] = [
        { id: "4", ledger: 103, type: "payment", data: { amount: 400 } },
      ];

      await listener.ingestEvents(newEvents);
      const newState = cursorStore.getState();
      expect(newState.lastProcessedLedger).toBe(103);
    });
  });

  describe("Multiple Reconnections", () => {
    it("should handle multiple reconnection cycles", async () => {
      await listener.connect();

      for (let cycle = 0; cycle < 3; cycle++) {
        const events: StellarEvent[] = [
          {
            id: `${cycle * 2 + 1}`,
            ledger: 100 + cycle * 2,
            type: "payment",
            data: { amount: 100 },
          },
          {
            id: `${cycle * 2 + 2}`,
            ledger: 101 + cycle * 2,
            type: "payment",
            data: { amount: 200 },
          },
        ];

        await listener.ingestEvents(events);

        // Disconnect and reconnect
        await listener.simulateStreamDisconnect();
        await listener.reconnect();
      }

      // Should have processed 6 events total
      expect(listener.getProcessedEventCount()).toBe(6);
      const state = cursorStore.getState();
      expect(state.cursor).toBe(6);
    });
  });

  describe("Cursor Persistence", () => {
    it("should persist cursor state across reconnections", async () => {
      await listener.connect();

      const events1: StellarEvent[] = [
        { id: "1", ledger: 100, type: "payment", data: { amount: 100 } },
        { id: "2", ledger: 101, type: "payment", data: { amount: 200 } },
      ];

      await listener.ingestEvents(events1);
      const stateBeforeDisconnect = cursorStore.getState();

      // Disconnect and reconnect
      await listener.simulateStreamDisconnect();
      await listener.reconnect();

      // Cursor should be preserved
      const stateAfterReconnect = cursorStore.getState();
      expect(stateAfterReconnect.cursor).toBe(stateBeforeDisconnect.cursor);
      expect(stateAfterReconnect.lastProcessedLedger).toBe(
        stateBeforeDisconnect.lastProcessedLedger
      );
    });
  });
});
