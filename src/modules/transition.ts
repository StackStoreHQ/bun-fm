import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { configSettings } from "../settings/config";
import type { IMedia } from "../settings/media";
import type { IAudioTransition } from "./audio";
import { loggerModule } from "./logger";

export interface ITransitionPreparation {
  audio: IAudioTransition | null;
  dispose: () => void;
}

const PCM_BYTES_PER_SECOND = 44100 * 2 * 2;
const MAX_SPEECH_SECONDS = 60;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

class TransitionModule {
  prepare(previous: IMedia, next: IMedia): ITransitionPreparation {
    const controller = new AbortController();
    let directory: string | undefined;
    let disposed = false;
    const cleanup = async () => {
      if (directory) {
        try {
          await fs.promises.rm(directory, { recursive: true, force: true });
        } catch (err) {
          loggerModule.error("Unable to remove transition audio:", err);
        }
      }
    };
    const preparation: ITransitionPreparation = {
      audio: null,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        preparation.audio = null;
        controller.abort();
        void completion.then(cleanup);
      },
    };
    const timer = setTimeout(() => {
      loggerModule.error("Transition preparation timed out; skipping it.");
      controller.abort();
    }, configSettings.transition.requestTimeoutSeconds * 1000);
    timer.unref();

    const run = async () => {
      const titles: Record<string, string> = {
        A: JSON.stringify(path.parse(previous.filename).name),
        B: JSON.stringify(path.parse(next.filename).name),
      };
      const prompt = configSettings.transition.prompt.replace(
        /\{(A|B)\}/g,
        (_, key: string) => titles[key]
      );
      const text = await this.generateText(prompt, controller.signal);
      const tts = configSettings.tts;
      const encoded = await this.request(
        `${tts.baseUrl.replace(/\/+$/, "")}/audio/speech`,
        tts.apiKey,
        {
          model: tts.model,
          voice: tts.voice,
          input: text,
          response_format: tts.format,
          speed: tts.speed,
        },
        controller.signal,
        MAX_RESPONSE_BYTES,
        "TTS"
      );
      const pcm = await this.decodeSpeech(encoded, controller.signal);
      controller.signal.throwIfAborted();
      directory = await fs.promises.mkdtemp(
        path.join(configSettings.storage.tmpDir, "bunfm-transition-")
      );
      const filePath = path.join(directory, "speech.pcm");
      await fs.promises.writeFile(filePath, pcm, {
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      preparation.audio = {
        filePath,
        durationSeconds: pcm.length / PCM_BYTES_PER_SECOND,
        musicDelaySeconds: configSettings.transition.musicDelaySeconds,
        musicVolume: configSettings.transition.musicVolume,
        musicRestoreSeconds: configSettings.transition.musicRestoreSeconds,
      };
      loggerModule.info(
        `Prepared radio transition: ${previous.filename} -> ${next.filename}`
      );
    };
    const completion = run()
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          loggerModule.error(
            "Transition preparation failed; skipping it:",
            err instanceof Error ? err.message : "Unknown error"
          );
        }
      })
      .finally(async () => {
        clearTimeout(timer);
        if (!preparation.audio) await cleanup();
      });
    return preparation;
  }

  private async generateText(prompt: string, signal: AbortSignal) {
    const llm = configSettings.llm;
    const response = await this.request(
      `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      llm.apiKey,
      {
        reasoning_effort: llm.thinking,
        model: llm.model,
        messages: [{ role: "user", content: prompt }],
        // Reasoning models share this budget with the final spoken text.
        max_tokens: 2048,
      },
      signal,
      64 * 1024,
      "LLM"
    );
    const completion = JSON.parse(response.toString("utf8")) as {
      choices?: { message?: { content?: unknown } }[];
    } | null;
    const text = completion?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("LLM returned no transition text");
    }
    if (Array.from(text.trim()).length > 180) {
      throw new Error("LLM transition text exceeded the 180-character limit");
    }
    return text.trim();
  }

  private async request(
    url: string,
    apiKey: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    maxBytes: number,
    provider: string
  ) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`${provider} request failed (HTTP ${response.status})`);
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error(`${provider} response exceeded the size limit`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }

  private decodeSpeech(encoded: Buffer, signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<Buffer>((resolve, reject) => {
      const inputArgs =
        configSettings.tts.format === "pcm"
          ? ["-f", "s16le", "-ar", "24000", "-ac", "1"]
          : [];
      const task = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-v",
          "error",
          ...inputArgs,
          "-i",
          "pipe:0",
          "-vn",
          "-ar",
          "44100",
          "-ac",
          "2",
          "-f",
          "s16le",
          "-c:a",
          "pcm_s16le",
          "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLong = false;
      const abort = () => task.kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      task.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > PCM_BYTES_PER_SECOND * MAX_SPEECH_SECONDS) {
          tooLong = true;
          task.kill("SIGKILL");
        } else {
          chunks.push(chunk);
        }
      });
      task.stderr.resume();
      task.stdin.on("error", () => {
        // A decoder exiting early closes stdin; its close event reports failure.
      });
      task.on("error", () => {
        signal.removeEventListener("abort", abort);
        reject(new Error("Unable to run FFmpeg to prepare transition audio"));
      });
      task.on("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          reject(new Error("Transition preparation cancelled"));
        } else if (tooLong) {
          reject(new Error("TTS audio exceeded the 60-second limit"));
        } else if (code !== 0 || size === 0 || size % 4 !== 0) {
          reject(new Error("FFmpeg could not decode TTS audio"));
        } else {
          resolve(Buffer.concat(chunks));
        }
      });
      task.stdin.end(encoded);
    });
  }
}

export const transitionModule = new TransitionModule();
