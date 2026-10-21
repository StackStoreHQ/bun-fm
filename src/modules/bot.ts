import TelegramBot, { Message } from "node-telegram-bot-api";
import path from "path";
import { configSettings } from "../settings/config";
import { mediaModule } from "./media";
import { loggerModule } from "./logger";
import fs from "fs";
import { botSettings } from "../settings/bot";
import { fmModule } from "./fm";
import { metadataSettings } from "../settings/metadata";
import { timeModule } from "./time";
import dayjs from "dayjs";

class BotModule {
  bot: TelegramBot;

  constructor() {
    this.bot = new TelegramBot(configSettings.telegram.botToken, {
      polling: true,
    });
    this.bot
      .setMyCommands(Object.values(botSettings.commands))
      .catch(loggerModule.error);
  }

  async init() {
    this.initPollEvent();
    this.initStartCommand();
    this.initListCommand();
    this.initRemoveCommand();
    this.initAudioMessage();
    this.initMuteCommand();
    this.initNextCommand();
  }

  async sendTextMessage(chatId: number, message: string, messageId?: number) {
    loggerModule.debug(message);
    return await this.bot.sendMessage(
      chatId,
      message,
      messageId === undefined
        ? undefined
        : {
            reply_to_message_id: messageId,
          },
    );
  }

  sendTextMessageSync(chatId: number, message: string, messageId?: number) {
    loggerModule.debug(message);
    this.bot
      .sendMessage(
        chatId,
        message,
        messageId === undefined
          ? undefined
          : {
              reply_to_message_id: messageId,
            },
      )
      .catch((err) => {
        loggerModule.error(err);
      });
  }

  sendErrorMessageSync(chatId: number, error: Error, messageId?: number) {
    const errorMessage = `ERROR: ${error.message}`;
    loggerModule.error(error);
    this.sendTextMessageSync(chatId, errorMessage, messageId);
  }

  initPollEvent() {
    this.bot.on("polling_error", (err) => {
      loggerModule.error("Bot on polling error: ", err);
    });
    this.bot.on("poll", () => {
      loggerModule.info("Bot on poll");
    });
  }

  initStartCommand() {
    this.bot.onText(
      new RegExp(`^\/${botSettings.commands.start.command}$`, "i"),
      (message) => {
        let text = `Welcome to ${metadataSettings.nickname}! 🎉🎉🎉\n\n`;
        text += metadataSettings.description + "\n\n";
        text += `Version：v${metadataSettings.version}\n`;
        text += `Uptime：${fmModule.getRunningTime()}\n\n`;
        text += `Listen：${configSettings.getDomain()}\n`;
        text += `Live Stream：${configSettings.getDomain().replace(/\/$/, "")}/stream\n\n`;
        text += `Commands：\n`;
        text += Object.values(botSettings.commands)
          .map((item) => {
            return `/${item.command} - ${item.description}`;
          })
          .join("\n");
        this.sendTextMessageSync(message.chat.id, text, message.message_id);
      },
    );
  }

  initListCommand() {
    this.bot.onText(
      new RegExp(`^\/${botSettings.commands.ls.command}$`, "i"),
      async (message) => {
        try {
          const medias = await mediaModule.getMediaNames();
          if (medias.length === 0) {
            const text = `Found ${medias.length} audio files.`; // 保持与删除命令相同的术语体系
            this.sendTextMessageSync(message.chat.id, text, message.message_id);
          } else {
            const perPage = 20;
            for (let i = 0; i < medias.length; i += perPage) {
              let text =
                i === 0 ? `Found ${medias.length} audio files: \n\n` : ""; // 冒号增强列表语义
              text += medias
                .slice(i, i + perPage)
                .map((name, index) => `[${i + index + 1}] ${name}`) // 保持序号格式一致性
                .join("\n");
              await this.sendTextMessage(
                message.chat.id,
                text,
                i === 0 ? message.message_id : undefined,
              );
            }
          }
        } catch (err) {
          this.sendErrorMessageSync(
            message.chat.id,
            err as Error,
            message.message_id,
          );
        }
      },
    );
  }

  initRemoveCommand() {
    this.bot.onText(
      new RegExp(`^\/${botSettings.commands.rm.command} ([0-9]+)$`, "i"),
      async (message, match) => {
        const chatId = message.chat.id;
        try {
          const mediaInfo = await mediaModule.getMediaByOrderString(
            match ? match[1] : "",
          );
          await fs.promises.unlink(mediaInfo.filePath);

          this.sendTextMessageSync(chatId, `Done`, message.message_id);
        } catch (err) {
          this.sendErrorMessageSync(chatId, err as Error, message.message_id);
        }
      },
    );
  }

  initMuteCommand() {
    this.bot.onText(
      new RegExp(`^\/${botSettings.commands.mute.command}$`, "i"),
      async (message) => {
        const chatId = message.chat.id;
        try {
          const muted = await fmModule.mute();
          this.sendTextMessageSync(
            chatId,
            muted ? "Muted" : "Unmuted",
            message.message_id,
          );
        } catch (err) {
          this.sendErrorMessageSync(
            message.chat.id,
            err as Error,
            message.message_id,
          );
        }
      },
    );
  }

  initNextCommand() {
    this.bot.onText(
      new RegExp(`^\/${botSettings.commands.next.command}$`, "i"),
      async (message, match) => {
        const chatId = message.chat.id;
        try {
          await fmModule.next();
          this.sendTextMessageSync(chatId, `Done`, message.message_id);
        } catch (err) {
          this.sendErrorMessageSync(
            message.chat.id,
            err as Error,
            message.message_id,
          );
        }
      },
    );
  }

  initAudioMessage() {
    const handle = async (message: Message) => {
      const chatId = message.chat.id;
      let audio = message.audio || message.voice;
      if (!audio) return;
      const fileId = audio.file_id;
      const messageId = message.message_id;
      // @ts-ignore
      const fileName = audio.file_name || `Voice_${message.date}.ogg`;
      try {
        const r = await this.sendTextMessage(
          chatId,
          `Downloading audio file...`,
          messageId,
        );
        const mediaNames = await mediaModule.getMediaNames();
        if (mediaNames.includes(fileName)) {
          await this.bot.editMessageText(
            `⚠️ Download rejected: [${fileName}] already exists.`,
            {
              chat_id: chatId,
              message_id: r.message_id,
            },
          );
          return;
        }
        const tmpFilePath = await this.bot.downloadFile(
          fileId,
          configSettings.storage.tmpDir,
        );
        const mediaFilePath = path.resolve(
          configSettings.storage.mediaDir,
          fileName,
        );
        await fs.promises.rename(tmpFilePath, mediaFilePath);

        await this.bot.editMessageText(`✅ File stored: ${fileName}`, {
          chat_id: chatId,
          message_id: r.message_id,
        });
      } catch (err) {
        this.sendErrorMessageSync(chatId, err as Error, message.message_id);
      }
    };
    this.bot.on("voice", handle);
    this.bot.on("audio", handle);
  }
}

export const botModule = new BotModule();
