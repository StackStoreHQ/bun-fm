import { configSettings } from "../settings/config";
import { mediaModule } from "./media";
import { EventEmitter } from "eventemitter3";
import { loggerModule } from "./logger";
import { timeModule } from "./time";
import { audioModule } from "./audio";
import { ChildProcess } from "child_process";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";
import fs from "fs";
import type { IMedia } from "../settings/media";
import type { IAudioTransition } from "./audio";
import { transitionModule } from "./transition";
import type { ITransitionPreparation } from "./transition";
import { nowPlayingModule } from "./now-playing";
dayjs.extend(duration);

interface IEvents {
  fmData: (chunk: Buffer) => void;
}

interface IQueuedMedia {
  media: IMedia;
  followingPaths: string[];
  preparation: ITransitionPreparation;
}

class FMModule extends EventEmitter<IEvents> {
  startupTime = Date.now();
  currentMediaIndex: number = -1;
  muted: boolean = false;
  readerTask: ChildProcess | null = null;
  private playbackVersion = 0;
  private lastMediaPath: string | null = null;
  from: "file" | "muteAudio" = "muteAudio";
  audioBufferCache: Buffer = Buffer.allocUnsafe(
    configSettings.server.bufferSize,
  );
  constructor() {
    super();
    audioModule.on("muteAudio", (chunk) => {
      this.emitFMData("muteAudio", chunk);
    });

    this.on("fmData", (chunk) => {
      const chunkLen = chunk.length;
      const cacheLen = this.audioBufferCache.length;
      if (chunkLen < cacheLen) {
        this.audioBufferCache.copyWithin(0, chunkLen);
        chunk.copy(this.audioBufferCache, cacheLen - chunkLen);
      } else {
        chunk.copy(this.audioBufferCache, 0, chunkLen - cacheLen, chunkLen);
      }
    });
  }

  getRunningTime() {
    const now = Date.now();
    const diffMs = now - this.startupTime;
    const duration = dayjs.duration(diffMs);
    const years = duration.years();
    const days = duration.days();
    const hours = duration.hours();
    const minutes = duration.minutes();
    const seconds = duration.seconds();

    const textArr = [];
    if (years > 0) {
      textArr.push(`${years}y`);
    }
    if (days > 0) {
      textArr.push(`${days}d`);
    }
    if (hours > 0) {
      textArr.push(`${hours}h`);
    }
    if (minutes > 0) {
      textArr.push(`${minutes}m`);
    }
    if (seconds > 0) {
      textArr.push(`${seconds}s`);
    }

    return textArr.join(" ");
  }

  private emitFMData(from: "file" | "muteAudio", chunk: Buffer) {
    if (this.muted) {
      if (from === "muteAudio") {
        return this.emit("fmData", chunk);
      }
    } else if (from === this.from) {
      return this.emit("fmData", chunk);
    }
  }

  async init() {
    let queued: IQueuedMedia | null = null;
    while (true) {
      this.from = "muteAudio";
      nowPlayingModule.clear();
      const version = this.playbackVersion;
      const planned = queued;
      queued = null;
      let incoming = planned?.preparation || null;
      // Snapshot readiness at the boundary; never await LLM or TTS here.
      let transition = incoming?.audio || undefined;
      if (!transition) incoming?.dispose();

      try {
        let mediaInfo: IMedia | null = null;
        if (planned) {
          const medias = await mediaModule.getMediasInfo();
          let index = medias.findIndex(
            (media) => media.filePath === planned.media.filePath,
          );
          if (
            configSettings.playback.random &&
            medias.length > 1 &&
            planned.media.filePath === this.lastMediaPath
          ) {
            index = -1;
          }
          if (index < 0) {
            incoming?.dispose();
            incoming = null;
            transition = undefined;
            if (!configSettings.playback.random) {
              const available = new Map(
                medias.map((media, order) => [media.filePath, order]),
              );
              const following = planned.followingPaths.find(
                (filePath) => available.has(filePath),
              );
              index = following === undefined ? -1 : available.get(following)!;
              this.currentMediaIndex = -1;
            }
          }
          if (index >= 0) {
            mediaInfo = medias[index];
            this.currentMediaIndex = index;
          }
        }
        if (!mediaInfo) mediaInfo = await this.getNextMediaInfo();
        if (mediaInfo === null) {
          await timeModule.sleep(2000);
          continue;
        }
        if (version !== this.playbackVersion) continue;

        this.lastMediaPath = mediaInfo.filePath;
        queued = await this.prepareNextMedia(mediaInfo);
        if (version !== this.playbackVersion) {
          queued?.preparation.dispose();
          queued = null;
          continue;
        }
        await this.playMedia(mediaInfo, version, transition);
        this.from = "muteAudio";
        this.readerTask = null;

        if (configSettings.storage.autoRemove) {
          await fs.promises.unlink(mediaInfo.filePath);
        }
      } catch (err) {
        this.from = "muteAudio";
        queued?.preparation.dispose();
        queued = null;
        loggerModule.error(err);
        await timeModule.sleep(2000);
      } finally {
        nowPlayingModule.clear();
        this.from = "muteAudio";
        this.readerTask = null;
        incoming?.dispose();
      }
    }
  }

  private async prepareNextMedia(current: IMedia) {
    if (!configSettings.transition.enabled) return null;
    try {
      const medias = (await mediaModule.getMediasInfo()).filter(
        (media) =>
          !configSettings.storage.autoRemove ||
          media.filePath !== current.filePath,
      );
      if (medias.length === 0) return null;
      const currentIndex = medias.findIndex(
        (media) => media.filePath === current.filePath,
      );
      const nextIndex = configSettings.playback.random
        ? this.getRandomMediaIndex(medias.length, currentIndex)
        : currentIndex >= 0
          ? (currentIndex + 1) % medias.length
          : Math.max(0, this.currentMediaIndex) % medias.length;
      const media = medias[nextIndex];
      return {
        media,
        followingPaths: medias
          .slice(nextIndex + 1)
          .concat(medias.slice(0, nextIndex))
          .map((item) => item.filePath),
        preparation: transitionModule.prepare(current, media),
      };
    } catch (err) {
      loggerModule.error("Unable to prepare the next radio transition:", err);
      return null;
    }
  }

  private async playMedia(
    media: IMedia,
    version: number,
    transition?: IAudioTransition,
  ) {
    let announced = false;
    const read = (intro?: IAudioTransition) =>
      audioModule.readAudioFile(
        media.filePath,
        (task) => {
          this.readerTask = task;
        },
        (buffer) => {
          if (version !== this.playbackVersion) return;
          if (!announced) {
            announced = true;
            nowPlayingModule.setMedia(media);
          }
          this.from = "file";
          this.emitFMData("file", buffer);
        },
        intro,
      );
    try {
      await read(transition);
    } catch (err) {
      if (!transition || version !== this.playbackVersion) throw err;
      loggerModule.error(
        "Transition playback failed; playing the track without narration:",
        err,
      );
      this.from = "muteAudio";
      await read();
    }
  }

  private getRandomMediaIndex(mediaCount: number, excludedIndex: number) {
    if (mediaCount <= 1 || excludedIndex < 0 || excludedIndex >= mediaCount) {
      return Math.floor(Math.random() * mediaCount);
    }
    const index = Math.floor(Math.random() * (mediaCount - 1));
    return index >= excludedIndex ? index + 1 : index;
  }

  resetMediaIndex(
    mediaCount: number,
    excludedIndex: number = this.currentMediaIndex,
  ) {
    let nextMediaIndex: number;
    if (configSettings.playback.random) {
      nextMediaIndex = this.getRandomMediaIndex(mediaCount, excludedIndex);
    } else {
      if (this.currentMediaIndex + 1 >= mediaCount) {
        nextMediaIndex = 0;
      } else {
        nextMediaIndex = this.currentMediaIndex + 1;
      }
    }
    this.currentMediaIndex = nextMediaIndex;
  }

  async getNextMediaInfo() {
    const medias = await mediaModule.getMediasInfo();
    const previousIndex = medias.findIndex(
      (media) => media.filePath === this.lastMediaPath,
    );
    this.resetMediaIndex(medias.length, previousIndex);
    return medias[this.currentMediaIndex] || null;
  }

  async next() {
    this.playbackVersion++;
    nowPlayingModule.clear();
    this.from = "muteAudio";
    this.killReaderTask();
  }

  async mute() {
    this.muted = !this.muted;
    return this.muted;
  }

  killReaderTask() {
    const task = this.readerTask;
    if (task && !task.killed) {
      task.kill("SIGKILL");
    }
  }
}

export const fmModule = new FMModule();
