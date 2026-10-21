import { execFile, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { promisify } from "util";
import type { IMedia } from "../settings/media";
import { loggerModule } from "./logger";

const execute = promisify(execFile);
const MAX_COVER_PIXELS = 4096 * 4096;
const MAX_ALLOCATION = 64 * 1024 * 1024;

interface ITrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string | null;
}

interface IProbe {
  format?: { tags?: Record<string, string> };
  streams?: {
    index: number;
    codec_type?: string;
    width?: number;
    height?: number;
    disposition?: { attached_pic?: number };
    tags?: Record<string, string>;
  }[];
}

class NowPlayingModule {
  track: ITrack | null = null;
  private cover: Buffer | null = null;
  private task: ChildProcess | null = null;

  clear() {
    this.track = null;
    this.cover = null;
    this.task?.kill();
    this.task = null;
  }

  setMedia(media: IMedia) {
    this.clear();
    const track: ITrack = {
      id: randomUUID(),
      title: path.parse(media.filename).name,
      artist: "",
      album: "",
      coverUrl: null,
    };
    this.track = track;
    this.load(media.filePath, track).catch(() => {
      if (this.track === track) {
        loggerModule.error(
          "Unable to read current track metadata; using filename."
        );
      }
    });
  }

  getCover(id: string) {
    return this.track?.id === id ? this.cover : null;
  }

  private async load(filePath: string, track: ITrack) {
    const probeTask = execute(
      "ffprobe",
      [
        "-v",
        "error",
        "-max_alloc",
        String(MAX_ALLOCATION),
        "-max_pixels",
        String(MAX_COVER_PIXELS),
        "-show_entries",
        "format_tags=title,artist,album:stream=index,codec_type,width,height:" +
          "stream_tags=title,artist,album:stream_disposition=attached_pic",
        "-of",
        "json",
        filePath,
      ],
      { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }
    );
    this.task = probeTask.child;
    const result = await probeTask;
    if (this.track !== track) return;
    this.task = null;
    const probe = JSON.parse(result.stdout) as IProbe;
    const tags = {
      ...probe.streams?.find((stream) => stream.codec_type === "audio")?.tags,
      ...probe.format?.tags,
    };
    const normalized = new Map(
      Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value])
    );
    for (const key of ["title", "artist", "album"] as const) {
      const value = normalized.get(key);
      if (typeof value === "string" && value.trim()) {
        track[key] = value.trim().slice(0, 1000);
      }
    }
    const picture = probe.streams?.find(
      (stream) => stream.disposition?.attached_pic === 1
    );
    if (!picture) return;
    if (!picture.width || !picture.height ||
      picture.width * picture.height > MAX_COVER_PIXELS) {
      loggerModule.error("Current track artwork exceeds the image size limit.");
      return;
    }

    try {
      const coverTask = execute(
        "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          "-max_alloc",
          String(MAX_ALLOCATION),
          "-max_pixels",
          String(MAX_COVER_PIXELS),
          "-i",
          filePath,
          "-map",
          `0:${picture.index}`,
          "-frames:v",
          "1",
          "-vf",
          "scale=900:900:force_original_aspect_ratio=decrease",
          "-c:v",
          "mjpeg",
          "-f",
          "image2pipe",
          "pipe:1",
        ],
        {
          encoding: "buffer",
          timeout: 5000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        }
      );
      this.task = coverTask.child;
      const image = await coverTask;
      if (this.track !== track) return;
      this.task = null;
      if (image.stdout.length > 0) {
        this.cover = image.stdout;
        track.coverUrl = `/api/cover/${track.id}`;
      }
    } catch {
      if (this.track === track) {
        loggerModule.error(
          "Unable to extract current track artwork; using default cover."
        );
      }
    }
  }
}

export const nowPlayingModule = new NowPlayingModule();
