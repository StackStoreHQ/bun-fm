import fs from "fs";
import { configSettings } from "../settings/config";
import type { IMedia } from "../settings/media";
import path from "path";

class MediaModule {
  async getMediasInfo() {
    const medias: IMedia[] = [];
    const filenames = await fs.promises.readdir(configSettings.storage.mediaDir);
    for (let i = 0; i < filenames.length; i++) {
      const filename = filenames[i];
      const filePath = path.resolve(configSettings.storage.mediaDir, filename);
      medias.push({
        order: i + 1,
        filename,
        filePath,
      });
    }
    return medias;
  }

  async getMediaNames() {
    const medias = await this.getMediasInfo();
    return medias.map((media) => media.filename);
  }

  async getMediaByOrderString(order: string) {
    const orderNumber = parseInt(order);
    if (isNaN(orderNumber)) {
      throw new Error("Invalid index format.");
    }
    const medias = await this.getMediasInfo();
    if (orderNumber < 1 || orderNumber > medias.length) {
      throw new Error("Invalid index.");
    }
    return medias[orderNumber - 1];
  }
}

export const mediaModule = new MediaModule();
