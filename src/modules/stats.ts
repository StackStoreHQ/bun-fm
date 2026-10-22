import fs from "fs";
import path from "path";
import { loggerModule } from "./logger";

interface IStoredStats {
  visits: number;
  listens: number;
}

class StatsModule {
  private readonly filePath = path.resolve(process.cwd(), "data", "stats.json");
  private stored: IStoredStats = { visits: 0, listens: 0 };
  private activeListeners = 0;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (
        !Number.isSafeInteger(stored.visits) ||
        stored.visits < 0 ||
        !Number.isSafeInteger(stored.listens) ||
        stored.listens < 0
      ) {
        throw new Error("Stored statistics contain invalid counters.");
      }
      this.stored = { visits: stored.visits, listens: stored.listens };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        loggerModule.error("Unable to load server statistics:", err);
      }
    }
  }

  getSnapshot(version: string) {
    return {
      version,
      uptimeSeconds: Math.floor(process.uptime()),
      visits: this.stored.visits,
      listens: this.stored.listens,
      online: this.activeListeners,
    };
  }

  async recordVisit() {
    this.stored.visits += 1;
    await this.persist();
  }

  startListening() {
    this.activeListeners += 1;
    this.stored.listens += 1;
    void this.persist();

    let listening = true;
    return () => {
      if (!listening) return;
      listening = false;
      this.activeListeners = Math.max(0, this.activeListeners - 1);
    };
  }

  private persist() {
    const snapshot = JSON.stringify(this.stored, null, 2) + "\n";
    this.pendingWrite = this.pendingWrite
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.filePath), {
          recursive: true,
        });
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(temporaryPath, snapshot, "utf8");
        await fs.promises.rename(temporaryPath, this.filePath);
      })
      .catch((err) => {
        loggerModule.error("Unable to save server statistics:", err);
      });
    return this.pendingWrite;
  }
}

export const statsModule = new StatsModule();
