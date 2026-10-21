import { EventEmitter } from "eventemitter3";
import { loggerModule } from "./logger";
import { spawn, ChildProcess } from "child_process";

interface IEvents {
  muteAudio: (chunk: Buffer) => void;
}

export interface IAudioTransition {
  // Prepared raw s16le PCM at 44100 Hz, stereo.
  filePath: string;
  durationSeconds: number;
  musicDelaySeconds: number;
  musicVolume: number;
  musicRestoreSeconds: number;
}

class AudioModule extends EventEmitter<IEvents> {
  constructor() {
    super();
  }

  async init() {
    this.initMuteAudioCreator().catch((err) => {
      loggerModule.errorExit(err);
    });
  }

  async initMuteAudioCreator() {
    return new Promise((resolve, reject) => {
      const muteAudioTask = spawn(
        "ffmpeg",
        [
          "-v",
          "quiet",
          "-re",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=44100:cl=stereo",
          "-tune",
          "zerolatency",
          "-f",
          "mp3",
          "-c:a",
          "mp3",
          "pipe:1",
        ],
        {
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      muteAudioTask.on("error", reject);
      muteAudioTask.on("close", (code) => {
        reject(new Error(`FFmpeg silence generator exited with code ${code}`));
      });
      muteAudioTask.stdout.on("data", (buf: Buffer) => {
        this.emit("muteAudio", buf);
      });
    });
  }

  async readAudioFile(
    filePath: string,
    onTask: (task: ChildProcess) => void,
    onBuffer: (buffer: Buffer) => void,
    transition?: IAudioTransition,
  ) {
    let inputArgs = ["-re", "-i", filePath];
    if (transition) {
      const durationSamples = Math.round(transition.durationSeconds * 44100);
      const delaySamples = Math.round(transition.musicDelaySeconds * 44100);
      if (
        !Number.isSafeInteger(durationSamples) ||
        durationSamples <= 0 ||
        !Number.isSafeInteger(delaySamples) ||
        delaySamples < 0 ||
        transition.musicDelaySeconds < 0 ||
        !Number.isFinite(transition.musicVolume) ||
        transition.musicVolume < 0 ||
        transition.musicVolume > 1 ||
        !Number.isFinite(transition.musicRestoreSeconds) ||
        transition.musicRestoreSeconds < 0 ||
        transition.musicRestoreSeconds > 60
      ) {
        throw new Error("Invalid audio transition timing or music volume");
      }

      const speechEnd = durationSamples / 44100;
      const restoreSeconds = transition.musicRestoreSeconds;
      const musicVolume = transition.musicVolume;
      // Evaluate smoothstep per sample to avoid gain steps between frames.
      const volumeFilter = restoreSeconds > 0
        ? `aeval='st(0,clip((t-${speechEnd})/${restoreSeconds},0,1));` +
          `val(ch)*(${musicVolume}+(1-${musicVolume})*` +
          "ld(0)*ld(0)*(3-2*ld(0)))':c=same"
        : `volume='if(lt(t,${speechEnd}),${musicVolume},1)':eval=frame`;

      const filter = [
        "[0:a]aresample=44100," +
          "aformat=sample_fmts=fltp:channel_layouts=stereo," +
          "asetpts=PTS-STARTPTS," +
          `adelay=${delaySamples}S:all=1,` +
          `${volumeFilter}[music]`,
        `[1:a]atrim=end_sample=${durationSamples},` +
          "asetpts=PTS-STARTPTS[speech]",
        "[speech][music]amix=inputs=2:duration=longest:" +
          "dropout_transition=0:normalize=0[mixed]",
        // Pace the delayed mix, not the music's original input timeline.
        "[mixed][2:a]amix=inputs=2:duration=first:" +
          "dropout_transition=0:normalize=0[out]",
      ].join(";");
      inputArgs = [
        "-i",
        filePath,
        "-f",
        "s16le",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-i",
        transition.filePath,
        "-re",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=stereo",
        "-filter_complex",
        filter,
        "-map",
        "[out]",
      ];
    }

    return new Promise<void>((resolve, reject) => {
      const task = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostats",
          "-v",
          "error",
          ...inputArgs,
          "-vn",
          "-ar",
          "44100",
          "-ac",
          "2",
          "-map_metadata",
          "-1",
          "-write_id3v2",
          "0",
          "-f",
          "mp3",
          "-c:a",
          "mp3",
          "pipe:1",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      let stderr = "";

      const failure = (message: string) => {
        let details = stderr.trim();
        for (const inputPath of [filePath, transition?.filePath]) {
          if (inputPath) {
            details = details.split(inputPath).join("[audio input]");
          }
        }
        return new Error(details ? `${message}: ${details}` : message);
      };

      const clearTimer = () => {
        clearTimeout(timer);
      };

      const setTimer = () => {
        clearTimer();
        timer = setTimeout(() => {
          timedOut = true;
          task.kill("SIGKILL");
        }, 3 * 1000);
      };

      task.on("close", (code, signal) => {
        clearTimer();
        if (timedOut) {
          reject(failure("FFmpeg produced no audio for 3 seconds"));
        } else if (task.killed || code === 0) {
          resolve();
        } else {
          reject(
            failure(
              signal
                ? `FFmpeg terminated by ${signal}`
                : `FFmpeg exited with code ${code}`,
            ),
          );
        }
      });

      task.on("error", (err) => {
        clearTimer();
        reject(new Error(`Unable to run FFmpeg: ${err.message}`));
      });

      task.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-16 * 1024);
      });

      task.stdout.on("data", (buf: Buffer) => {
        onBuffer(buf);
        setTimer();
      });

      setTimer();
      onTask(task);
    });
  }
}

export const audioModule = new AudioModule();
