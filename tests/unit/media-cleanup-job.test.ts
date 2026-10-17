import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaCleanupJob } from "../../src/modules/media/media.cleanup-job.js";

afterEach(() => vi.useRealTimers());

describe("MediaCleanupJob", () => {
  it("runs the cleanup on every interval and stops when asked", async () => {
    vi.useFakeTimers();
    const cleanupExpired = vi.fn().mockResolvedValue(0);
    const job = new MediaCleanupJob({ cleanupExpired }, 1000);

    job.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(cleanupExpired).toHaveBeenCalledTimes(3);

    job.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(cleanupExpired).toHaveBeenCalledTimes(3);
  });

  it("start() twice does not double the schedule", async () => {
    vi.useFakeTimers();
    const cleanupExpired = vi.fn().mockResolvedValue(0);
    const job = new MediaCleanupJob({ cleanupExpired }, 1000);

    job.start();
    job.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(cleanupExpired).toHaveBeenCalledTimes(1);
    job.stop();
  });

  it("skips a run while the previous one is still in progress", async () => {
    let release!: () => void;
    const cleanupExpired = vi.fn().mockImplementation(() => new Promise<number>((r) => (release = () => r(2))));
    const job = new MediaCleanupJob({ cleanupExpired });

    const first = job.runOnce();
    expect(await job.runOnce()).toBe(0); // overlapping call is a no-op
    expect(cleanupExpired).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toBe(2);
  });

  it("survives a failing run and works again afterwards", async () => {
    const cleanupExpired = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(4);
    const job = new MediaCleanupJob({ cleanupExpired });

    expect(await job.runOnce()).toBe(0);
    expect(await job.runOnce()).toBe(4);
  });
});
