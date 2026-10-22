import express from "express";
import { botModule } from "./modules/bot";
import { audioModule } from "./modules/audio";
import { loggerModule } from "./modules/logger";
import { fmModule } from "./modules/fm";
import { configSettings } from "./settings/config";
import { metadataSettings } from "./settings/metadata";
import { nowPlayingModule } from "./modules/now-playing";
import { statsModule } from "./modules/stats";

const app = express();

app.use((req, _res, next) => {
  const isPage = req.method === "GET" &&
    (req.path === "/" || req.path === "/index.html");
  const destination = req.get("sec-fetch-dest");
  if (!isPage || (destination && destination !== "document")) {
    next();
    return;
  }
  statsModule.recordVisit().then(next, next);
});

app.use(express.static("public"));

app.get("/api/site", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...configSettings.site, streamUrl: "/stream" });
});

app.get("/api/now-playing", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ track: nowPlayingModule.track, muted: fmModule.muted });
});

app.get("/api/stats", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(statsModule.getSnapshot(metadataSettings.version));
});

app.get("/api/cover/:id", (req, res) => {
  const cover = nowPlayingModule.getCover(String(req.params.id));
  if (!cover) {
    res.status(404).end();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.type("image/jpeg").send(cover);
});

app.get("/stream", async (req, res) => {
  res.setHeader("Bun-FM-Name", metadataSettings.nickname);
  res.setHeader("Bun-FM-Description", metadataSettings.description);
  res.setHeader("Bun-FM-Version", metadataSettings.version);
  res.setHeader("Bun-FM-Author", `${metadataSettings.author}`);
  res.setHeader("Bun-FM-URL", `${metadataSettings.homePage}`);
  res.setHeader("Bun-FM-Icon", `/icon.jpg`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const stopListening = statsModule.startListening();
  res.write(fmModule.audioBufferCache);

  const onFMData = (buffer: Buffer) => {
    if (res.writable) {
      res.write(buffer, (err) => {
        if (err) {
          loggerModule.error(err);
        }
      });
    }
  };
  fmModule.on("fmData", onFMData);
  let closed = false;
  const onClose = () => {
    if (closed) return;
    closed = true;
    fmModule.off("fmData", onFMData);
    stopListening();
  };
  res.socket?.once("close", onClose);
  req.socket.once("close", onClose);
});

app.listen(
  configSettings.server.port,
  configSettings.server.host,
  async () => {
    try {
      loggerModule.info(
        `Server is running at http://${configSettings.server.host}:${configSettings.server.port}.`,
      );
      if (configSettings.telegram.botToken) {
        await botModule.init();
      }
      await audioModule.init();
      await fmModule.init();
    } catch (err) {
      loggerModule.error(err);
    }
  },
);
